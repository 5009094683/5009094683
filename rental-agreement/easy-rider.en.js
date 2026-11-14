/*
  EASY RIDER SERVICE AGREEMENT — English wording.
  (The customer rides as a passenger behind one of the company's drivers.)
  Wording shared with the other agreements is in common.en.js.

  Inside any text you can use **bold text**, {blank} (an empty line to fill in by hand),
  {heart}, and numbers from config.js such as {depositPercent} {luggageLimitKg} {helmetFee}.

  To add or remove a clause, add or delete a line in a "clauses" list.
*/
window.AGREEMENT_CONTENT = window.AGREEMENT_CONTENT || {};

window.AGREEMENT_CONTENT.en = {
  tagline: "Easy Rider Tours",
  title: "Easy Rider Service Agreement",

  sections: {
    provider: "Service provider (Party A)",
    passenger: "Passenger (Party B)",
    trip: "Trip details",
    price: "Price & payment",
    confirm: "Safety check & signing",
    confirmWhen: "Before departure",
  },

  fields: {
    health: "Health conditions, allergies, medication",

    route: "Route",
    driver: "Driver",
    driverPhone: "Driver's phone",
    includedItems: [
      "Driver-guide",
      "Motorbike & fuel",
      "Helmet",
      "Raincoat",
      "Knee & elbow guards",
      "Accommodation",
      "Meals",
      "Entrance tickets",
    ],

    pricePerDay: "Price per day",
  },

  // Tick boxes printed above the signatures.
  declarations: [
    "I have received a helmet that fits and a safety briefing from the driver.",
    "I am fit to ride as a passenger and have declared my health conditions in section 2.",
    "I hold travel insurance that covers motorbike travel.",
    "I am not insured and ride at my own risk.",
    "I agree that photos and videos of the trip may be used by Party A for promotion.",
  ],
  confirmStatement:
    "Both parties confirm the details above. Party B has read and accepts the terms overleaf.",

  signature: {
    roleA: "Service provider",
    roleB: "Passenger",
  },

  articles: [
    {
      title: "The service and responsibilities of Party A",
      clauses: [
        "Party A provides a motorbike with a driver-guide to carry Party B as a passenger on the route in section 3. Party B does not drive the motorbike.",
        "**Driver & motorbike:** The driver holds a valid driving licence and never rides after drinking alcohol. The motorbike is roadworthy, registered and insured as Vietnamese law requires. Party A provides a certified helmet.",
        "**Safety first:** The driver may change the route or timing, or stop the trip, when weather, road conditions or safety require it. After a breakdown, accident or illness, Party A promptly arranges help, repair or a replacement.",
      ],
    },
    {
      title: "Responsibilities of Party B and safety rules",
      clauses: [
        "**On the motorbike:** Party B must keep the helmet fastened, follow the driver's instructions, hold on and not distract the driver. Long trousers and closed shoes are recommended.",
        "**Alcohol & drugs:** The driver may refuse to carry a passenger who is under the influence of alcohol or drugs or who ignores the safety rules; no refund is due.",
        "**Health:** Party B confirms that they are fit to travel as a passenger on mountain roads. The trip is not recommended during pregnancy or for people with serious heart, back or neck conditions.",
        "**Luggage, documents & damage:** Luggage on the motorbike is limited to {luggageLimitKg} kg. Party B must carry an original passport or ID card (required in the border area), look after their own valuables, and pay for any damage they cause to the motorbike or equipment, including {helmetFee} VND for a lost or damaged helmet.",
      ],
    },
    {
      title: "Payment, cancellation and changes",
      clauses: [
        "**Booking & payment:** The booking is confirmed by a deposit of {depositPercent}% of the total price; the balance is paid before departure. The price covers the services ticked in section 3; drinks, tips and personal expenses are not included.",
        {
          text: "**Cancellation by Party B** must be sent by message or email. Counted back from the departure time:",
          items: [
            "{cancelFreeHours} hours or more before: all amounts paid are refunded, less bank fees.",
            "Less than {cancelFreeHours} hours but at least {cancelLateHours} hours before: {cancelMidCharge}% of the total price is charged.",
            "Less than {cancelLateHours} hours before, no-show, or leaving a trip that has started: 100% of the total price is charged.",
          ],
        },
        "**Cancellation by Party A & force majeure:** If Party A cannot run or complete the trip, Party B may choose another date or a refund of the unused days. In case of force majeure (storm, flood, landslide, road closure, order of the authorities), supplier costs that cannot be recovered are deducted from the refund.",
      ],
    },
    {
      title: "Risk, insurance and liability",
      clauses: [
        "**Risk:** Travelling by motorbike on mountain roads carries risks that cannot be removed completely, including accident and injury. Party B takes part voluntarily and accepts these risks.",
        "**Insurance:** Party B is strongly advised to hold travel insurance that covers riding as a motorbike passenger, medical care and emergency evacuation.",
        "**Liability:** Party A is liable for damage caused by the fault of its driver under Vietnamese law. It is not liable for loss or injury caused by Party B's breach of the safety rules, undeclared health conditions, third parties or force majeure.",
      ],
    },
    {
      title: "General provisions",
      clauses: [
        "Passengers under 18 ride only with the written consent of a parent or guardian.",
        "Complaints must be raised with the driver or Party A during the trip, or in writing within 07 days after it ends.",
        "Disputes are settled by negotiation first, then by the Court where Party A is based, under the laws of Vietnam.",
        "This agreement is made in two (02) copies of equal validity; each party keeps one (01) copy.",
      ],
    },
  ],
};
