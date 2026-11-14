/*
  MOTORBIKE RENTAL AGREEMENT — English wording.
  Wording shared with the other agreements is in common.en.js.

  Inside any text you can use **bold text**, {blank} (an empty line to fill in by hand),
  {heart}, and numbers from config.js such as {helmetFee} {keyFee} {agreedBikeValue}.

  To add or remove a clause, add or delete a line in a "clauses" list.
*/
window.AGREEMENT_CONTENT = window.AGREEMENT_CONTENT || {};

window.AGREEMENT_CONTENT.en = {
  tagline: "Motorbike Rental",
  title: "Motorbike Rental Agreement",

  sections: {
    lessor: "Rental company (Party A)",
    renter: "Renter (Party B)",
    vehicle: "Motorbike & rental period",
    price: "Rental price & deposit",
    handover: "Motorbike handover",
    handoverWhen: "At pick-up",
    settlement: "Settlement of agreement",
    settlementWhen: "At return",
  },

  fields: {
    phone: "Phone",
    address: "Address",
    emergencyPhone: "Emergency contact number",
    idIssueDate: "Date of issue",
    idExpiryDate: "Date of expiry",
    idIssuePlace: "Place of issue",
    licenceClass: "Driving licence class",
    licenceNumber: "Licence No.",

    model: "Motorbike model",
    colour: "Colour",
    condition: "Condition",
    conditionText: "Motorbike in normal working order.",
    conditionNotes: "Notes (existing scratches, damage):",
    accessories: "Accessories included",
    accessoryItems: ["helmet(s)", "raincoat(s)", "vehicle papers (copy)"],
    pickup: "Pick-up (time · date)",
    return: "Return (time · date)",
    totalDays: "Total rental period",
    days: "day(s)",

    rate: "Rental rate",
    perDay: "VND / day",
    totalFee: "Total rental fee",
    deposit: "Collateral / deposit (held by Party A)",
  },

  handoverStatement:
    "Both parties confirm that Party B has received the motorbike, papers and accessories as described above.",
  settlementStatement:
    "Party A confirms it has received back the motorbike and accessories. Party B has received back the collateral/deposit and has paid all charges.",

  signature: {
    roleA: "Rental company",
    roleB: "Renter",
  },

  articles: [
    {
      title: "Obligations and responsibilities of the Renter (Party B)",
      clauses: [
        "**Compliance with the law:** Party B is fully responsible for their own safety and for any legal risk while riding on public roads.",
        "**Traffic fines:** Party B shall pay 100% of the fines for any traffic violation (including fines issued later from traffic cameras) committed during the rental period, even if the agreement has ended and Party A receives the notice afterwards.",
        "**Prohibited acts:** Party B must NEVER pawn, mortgage, sell or sub-rent the motorbike, or use it to transport goods in violation of the law.",
        "**Use of the motorbike:** Party B pays for fuel (Party A does not refund unused fuel). To extend the rental, Party B must give notice at least one (01) day in advance.",
      ],
    },
    {
      title: "Risk, damage and compensation",
      clauses: [
        {
          text: "**Damage caused by Party B** (accident, collision, dropping the motorbike, etc.):",
          items: [
            "Party B shall pay 100% of the cost of repairs and replacement with genuine parts, and the cost of transporting the motorbike back to Party A's premises.",
            "Party B shall pay the rental fee for the days the motorbike is off the road for repair.",
          ],
        },
        "**Theft or total loss:** Party B shall compensate Party A with the actual market value of the motorbike at the time of the incident (or the agreed value of: {agreedBikeValue} VND).",
        "**Accessories:** Compensation of {helmetFee} VND for each lost or damaged helmet; {keyFee} VND if the key is lost.",
      ],
    },
    {
      title: "Obligations of the Rental Company (Party A)",
      clauses: [
        "To support the cost of repair and roadside rescue if the motorbike breaks down due to normal wear and tear or a technical fault (broken brake cable, engine failure, etc.), after inspection and verification.",
        "To refund the unused rental fee if Party B returns the motorbike earlier than agreed, and to return the collateral/deposit when the agreement is settled.",
        "Party A has the right to take back the motorbike immediately, without refund, if Party B breaches the prohibited acts above or seriously violates traffic law.",
      ],
    },
    {
      title: "General provisions",
      clauses: [
        "Both parties undertake to comply with this agreement. Any dispute shall first be settled by negotiation. If negotiation fails, the Court where Party A is based shall have jurisdiction in accordance with the current Civil Code of Vietnam.",
        "This agreement is made in two (02) copies of equal validity; each party keeps one (01) copy.",
      ],
    },
  ],
};
