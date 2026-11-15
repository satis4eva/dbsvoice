import { record } from "./store.js";
import { notify } from "./notify.js";
import { findSlots, bookSlot, bookingEnabled } from "./calendar.js";

const callerNumber = (call) => call?.from_number || call?.retell_llm_dynamic_variables?.caller_number || "";

/**
 * Each handler receives (tenant, args, call) and returns an object.
 * Retell hands the returned JSON to the AI, so `instruction` tells it what to say next.
 */
export const handlers = {
  async take_message(tenant, a, call) {
    const row = record(tenant.id, "messages", {
      call_id: call?.call_id, caller_name: a.caller_name, callback_number: a.callback_number || callerNumber(call),
      message: a.message, urgency: a.urgency || "normal",
    });
    await notify(tenant, `${row.urgency === "urgent" ? "URGENT " : ""}Message from ${row.caller_name || "a caller"}`, {
      Name: row.caller_name, "Call back on": row.callback_number, Urgency: row.urgency, Message: row.message, "Call ID": row.call_id,
    });
    return { saved: true, instruction: "Confirm the message has been passed on and someone will get back to them. Ask if there is anything else." };
  },

  async qualify_lead(tenant, a, call) {
    const score = ["hot", "warm", "cold"].includes(a.score) ? a.score : "warm";
    const row = record(tenant.id, "leads", {
      call_id: call?.call_id, score, caller_name: a.caller_name, company: a.company, phone: a.phone || callerNumber(call),
      email: a.email, need: a.need, budget: a.budget, timeline: a.timeline, answers: a.answers, notes: a.notes,
    });
    await notify(tenant, `${score.toUpperCase()} lead: ${row.caller_name || "unknown"}${row.company ? ` (${row.company})` : ""}`, {
      Score: score, Name: row.caller_name, Company: row.company, Phone: row.phone, Email: row.email,
      Need: row.need, Budget: row.budget, Timeline: row.timeline, Answers: row.answers, Notes: row.notes, "Call ID": row.call_id,
    });
    const canTransfer = Boolean(tenant.transfer_number);
    const instruction =
      score === "hot" && canTransfer
        ? "This is a hot lead. Offer to connect them to the team right now. If they agree, use transfer_to_team. Otherwise offer to book a call."
        : bookingEnabled(tenant)
          ? "Thank them. Offer to book a follow-up call using check_availability."
          : "Thank them and say the team will be in touch shortly.";
    return { saved: true, score, instruction };
  },

  async check_availability(tenant, a) {
    try {
      const slots = await findSlots(tenant, { date: a.date });
      if (!slots.length) return { slots: [], instruction: "No free times on that day. Offer another day or to take a message." };
      return { slots, instruction: "Offer two or three of these times in natural speech. When they choose one, call book_appointment with its start_iso." };
    } catch (e) {
      console.error(`[check_availability:${tenant.id}]`, e.message);
      return { error: true, instruction: "The diary can't be reached right now. Apologise, take their details with take_message and say the team will call to arrange a time." };
    }
  },

  async book_appointment(tenant, a, call) {
    try {
      const res = await bookSlot(tenant, {
        startIso: a.start_iso, callerName: a.caller_name, callerPhone: a.phone || callerNumber(call), callerEmail: a.email, reason: a.reason,
      });
      if (!res.booked) return { booked: false, instruction: "That time has just been taken. Call check_availability again and offer other times." };
      record(tenant.id, "bookings", { call_id: call?.call_id, start_iso: a.start_iso, caller_name: a.caller_name, phone: a.phone || callerNumber(call), email: a.email, reason: a.reason, event_id: res.event_id });
      await notify(tenant, `New booking: ${a.caller_name || "Caller"}, ${res.spoken}`, {
        When: res.spoken, Name: a.caller_name, Phone: a.phone || callerNumber(call), Email: a.email, Reason: a.reason, "Calendar link": res.link,
      });
      return { booked: true, when: res.spoken, instruction: `Confirm the booking for ${res.spoken}. Ask if there is anything else.` };
    } catch (e) {
      console.error(`[book_appointment:${tenant.id}]`, e.message);
      return { booked: false, instruction: "Booking failed. Apologise, take a message with their preferred time and say the team will confirm." };
    }
  },
};

/** Tool definitions given to Retell (used by scripts/create-agent.js). */
export function toolDefinitions(baseUrl) {
  const custom = (name, description, properties, required, speakDuring) => ({
    type: "custom",
    name,
    description,
    url: `${baseUrl}/tools/${name}`,
    method: "POST",
    speak_during_execution: Boolean(speakDuring),
    ...(speakDuring ? { execution_message_description: speakDuring } : {}),
    speak_after_execution: true,
    timeout_ms: 15000,
    parameters: { type: "object", properties, required },
  });
  const str = (description) => ({ type: "string", description });

  return [
    { type: "end_call", name: "end_call", description: "End the call politely once the caller has nothing else." },
    {
      type: "transfer_call",
      name: "transfer_to_team",
      description: "Transfer the caller to a human on the team. Follow the transfer rules in the prompt.",
      transfer_destination: { type: "predefined", number: "{{transfer_number}}" },
      transfer_option: { type: "cold_transfer" },
    },
    custom("take_message", "Save a message for the team and notify them. Use when the caller wants to leave a message or nobody is available.", {
      caller_name: str("Caller's full name"),
      callback_number: str("Best number to call back, in international format if possible"),
      message: str("The message, in the caller's words, with any key details"),
      urgency: { type: "string", enum: ["normal", "urgent"], description: "urgent only if the caller says it is time-critical" },
    }, ["caller_name", "message"]),
    custom("qualify_lead", "Save a qualified sales lead after asking the qualification questions.", {
      caller_name: str("Caller's full name"),
      company: str("Company or business name, if any"),
      phone: str("Contact number"),
      email: str("Email address, spelled back to confirm"),
      need: str("What they are looking for"),
      budget: str("Budget, if given"),
      timeline: str("When they want to start"),
      answers: str("Short summary of answers to each qualification question"),
      score: { type: "string", enum: ["hot", "warm", "cold"], description: "Score using the hot lead criteria in the prompt" },
      notes: str("Anything else useful"),
    }, ["caller_name", "need", "score"]),
    custom("check_availability", "Look up free appointment times in the diary. Only use when booking is enabled.", {
      date: str("Optional date the caller wants, as YYYY-MM-DD. Leave empty to get the next available times."),
    }, [], "Say you'll just check the diary."),
    custom("book_appointment", "Book a time the caller has chosen from check_availability.", {
      start_iso: str("The start_iso value of the chosen slot, exactly as returned"),
      caller_name: str("Caller's full name"),
      phone: str("Contact number"),
      email: str("Email address, if given"),
      reason: str("What the appointment is about"),
    }, ["start_iso", "caller_name"], "Say you're booking that in now."),
  ];
}
