/*
  COMPANY SETTINGS — shared by every language version of the agreement.

  How to change the agreement:
    1. Company name, phone numbers, logo, colour, fees  ->  this file
    2. Wording (labels, terms & conditions)             ->  content.vi.js / content.en.js
    3. Which boxes appear on the form and their order   ->  agreement.html
    4. Fonts, sizes, spacing                            ->  assets/agreement.css

  After saving, refresh agreement.html in the browser and press Print.
  To refresh the ready-made files in the pdf/ folder, run:  node build-pdf.mjs
*/
window.AGREEMENT_CONFIG = {
  company: {
    name: "Cao Bằng Travel Guide",

    // Shown in the page header, in the "Party A" box and in the footer.
    // Add, remove or reorder lines freely, e.g. { label: "Email", value: "..." }.
    contacts: [
      { label: "Zalo", value: "0914 674 724" },
      { label: "WhatsApp", value: "+(84) 0352 476 994" },
    ],

    // Optional. Leave "" to hide the address line.
    address: "",

    // Optional. Path to your own logo image, e.g. "assets/my-logo.png".
    // Leave "" to use the built-in mountain emblem.
    logo: "",
  },

  // Brand colour used for headings, rules and the emblem.
  accentColor: "#0f5f4f",

  // Bike models printed as tick boxes, e.g. ["Honda Wave", "Honda Vision", "Honda XR 150"].
  // Leave empty to print a blank "Model" box that is filled in by hand.
  bikeModels: [],

  // Amounts in VND, digits only. Use null to print a blank line that is filled in by hand.
  helmetFee: 300000,
  keyFee: 300000,
  agreedBikeValue: null,

  // "Socialist Republic of Vietnam / Independence – Freedom – Happiness" heading.
  showNationalHeader: true,

  // "No. ______" line under the title.
  showAgreementNumber: true,
};
