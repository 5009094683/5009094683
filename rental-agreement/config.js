/*
  SETTINGS shared by every agreement and every language.

  Where to change things:
    1. Company name, phone numbers, logo, colour, fees, policies   ->  this file
    2. Wording used by every agreement (header, signature labels)   ->  common.vi.js / common.en.js
    3. Wording of one agreement, including its terms               ->  <agreement>.vi.js / <agreement>.en.js
    4. Which boxes appear on a form and their order                ->  <agreement>.html
    5. Fonts, sizes, spacing                                       ->  assets/agreement.css

  The agreements are:  motorbike-rental  ·  tour-package  ·  easy-rider

  After saving, refresh the page in the browser and press Print.
  To refresh the ready-made files in the pdf/ folder, run:  node build-pdf.mjs
*/
window.AGREEMENT_CONFIG = {
  company: {
    name: "Cao Bằng Travel Guide",

    // Shown at the top right of page 1 only.
    // Add, remove or reorder lines freely, e.g. { label: "Email", value: "..." }.
    contacts: [
      { label: "Zalo", value: "0914 674 724" },
      { label: "WhatsApp", value: "+(84) 0352 476 994" },
    ],

    // Optional. Printed under the company name in section 1. Leave "" to hide it.
    address: "",

    // Optional. Path to your own logo image, e.g. "assets/my-logo.png".
    // Leave "" to use the built-in mountain emblem.
    logo: "",
  },

  // Brand colour used for headings, rules and the emblem.
  accentColor: "#0f5f4f",

  // "Socialist Republic of Vietnam / Independence – Freedom – Happiness" heading.
  showNationalHeader: true,

  // "No. ______" line under the title.
  showAgreementNumber: true,

  /*
    Numbers printed inside the terms. Write plain digits.
    Use null to print a blank line that is filled in by hand.
  */

  // ---------- Motorbike rental ----------

  // Bike models printed as tick boxes, e.g. ["Honda Wave", "Honda Vision", "Honda XR 150"].
  // Leave empty to print a blank "Model" box that is filled in by hand.
  bikeModels: [],

  // Compensation in VND. The helmet amount is also used in the Easy Rider agreement.
  helmetFee: 300000,
  keyFee: 300000,
  agreedBikeValue: null,

  // ---------- Tour packages and Easy Rider ----------

  // Deposit that confirms a booking, as a percentage of the total price.
  depositPercent: 30,

  // When the customer cancels, counted in hours before the start:
  //   cancelFreeHours or more before   ->  everything paid is refunded
  //   between the two                  ->  cancelMidCharge % of the total price is charged
  //   less than cancelLateHours before ->  100% is charged
  cancelFreeHours: 72,
  cancelLateHours: 24,
  cancelMidCharge: 50,

  // ---------- Easy Rider ----------

  // Luggage carried on the motorbike, in kg per passenger.
  luggageLimitKg: 10,
};
