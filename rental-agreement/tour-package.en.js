/*
  TOUR PACKAGE AGREEMENT — English wording.
  Wording shared with the other agreements is in common.en.js.

  Inside any text you can use **bold text**, {blank} (an empty line to fill in by hand),
  {heart}, and numbers from config.js such as {depositPercent} {cancelFreeHours}.

  To add or remove a clause, add or delete a line in a "clauses" list.
*/
window.AGREEMENT_CONTENT = window.AGREEMENT_CONTENT || {};

window.AGREEMENT_CONTENT.en = {
  tagline: "Tour Packages",
  title: "Tour Package Agreement",

  sections: {
    provider: "Service provider (Party A)",
    customer: "Customer (Party B)",
    tour: "Tour details",
    price: "Price & payment",
    confirm: "Booking confirmation",
    confirmWhen: "At booking",
  },

  fields: {
    email: "Email",
    otherTravellers: "Other travellers in the group (full names)",
    totalTravellers: "Total travellers",

    route: "Tour / route",
    tourType: "Type of tour",
    tourTypes: ["Private", "Group"],
    includedItems: ["Transport", "Guide", "Accommodation", "Meals", "Entrance tickets", "Drinking water"],
    specialRequests: "Special requests (diet, allergies, health)",
    travelInsurance: "Travel insurance",
    insuranceOptions: ["Own policy", "Included", "None"],

    pricePerPerson: "Price per person",
  },

  // Tick boxes printed above the signatures.
  declarations: [
    "I agree that photos and videos of the tour may be used by Party A for promotion.",
  ],
  confirmStatement:
    "Both parties confirm the above. Party B signs for all travellers listed and accepts the terms overleaf.",

  signature: {
    roleA: "Service provider",
    roleB: "Customer",
  },

  articles: [
    {
      title: "Booking, price and payment",
      clauses: [
        "**Booking:** The booking is confirmed when Party B signs this agreement and pays a deposit of {depositPercent}% of the total price. The balance is paid before the tour starts.",
        "**Price:** The price covers the services ticked in section 3 and listed in the tour programme sent to Party B, which forms part of this agreement. Drinks, tips and personal expenses are not included.",
      ],
    },
    {
      title: "Cancellation, changes and force majeure",
      clauses: [
        {
          text: "**Cancellation by Party B** must be sent by message or email. Counted back from the start time of the tour:",
          items: [
            "{cancelFreeHours} hours or more before: all amounts paid are refunded, less bank fees.",
            "Less than {cancelFreeHours} hours but at least {cancelLateHours} hours before: {cancelMidCharge}% of the total price is charged.",
            "Less than {cancelLateHours} hours before, no-show, or leaving a tour that has started: 100% of the total price is charged.",
          ],
        },
        "**Changes by Party B** to the date, route or number of travellers depend on availability; Party B pays any extra cost.",
        "**Cancellation by Party A:** If Party A cannot run the tour, Party B may choose another date or a full refund.",
        "**Safety and weather:** Party A may change the route, order of visits, transport or accommodation to an equivalent standard when weather, road conditions or safety require it.",
        "**Force majeure** (storm, flood, landslide, epidemic, road closure, order of the authorities): neither party is liable for failing to perform. Party A refunds the services not yet used, less supplier costs that cannot be recovered.",
      ],
    },
    {
      title: "Responsibilities of Party B",
      clauses: [
        "**Documents & health:** Party B must carry an original passport or ID card at all times (required in the border area) and tell Party A before departure about any health condition, allergy or special need.",
        "**Conduct:** Party B must follow the safety instructions of the guide and driver, be on time, respect local people, customs and the environment, and obey Vietnamese law. Party A may stop serving, without refund, a traveller who endangers others or breaks the law.",
        "**Belongings & damage:** Party B looks after their own belongings and pays for any damage they cause to vehicles, accommodation or equipment.",
      ],
    },
    {
      title: "Responsibilities of Party A, insurance and liability",
      clauses: [
        "Party A provides the agreed services with qualified guides and drivers and safe, legal vehicles, and assists Party B in case of illness, accident or emergency.",
        "**Insurance:** Travel insurance is part of the tour only if “Included” is ticked in section 3. Otherwise Party B is strongly advised to hold their own insurance covering medical care, accidents and emergency evacuation.",
        "**Liability:** Party A is liable for damage caused by its own fault in accordance with Vietnamese law. It is not liable for loss, injury or delay caused by Party B's breach of this agreement, undeclared health conditions, third parties outside Party A's control or force majeure.",
      ],
    },
    {
      title: "General provisions",
      clauses: [
        "Travellers under 18 take part only with a parent or guardian, or with their written consent.",
        "Complaints must be raised with the guide or Party A during the tour, or in writing within 07 days after it ends.",
        "Disputes are settled by negotiation first, then by the Court where Party A is based, under the laws of Vietnam.",
        "This agreement is made in two (02) copies of equal validity; each party keeps one (01) copy.",
      ],
    },
  ],
};
