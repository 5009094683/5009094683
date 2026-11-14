/*
  ENGLISH WORDING shared by every agreement.

  Each agreement keeps its own wording in <agreement>.en.js.
  When the same line exists in both files, the agreement's own file wins.

  Inside any text you can use:
    **bold text**        printed in bold
    {blank}              an empty line to fill in by hand
    {heart}              a small heart symbol
    {depositPercent} {helmetFee} ...   numbers taken from config.js
*/
window.AGREEMENT_COMMON = window.AGREEMENT_COMMON || {};

window.AGREEMENT_COMMON.en = {
  languageName: "English",
  thousandsSeparator: ",",

  nationalName: "Socialist Republic of Vietnam",
  nationalMotto: "Independence – Freedom – Happiness",
  agreementNumber: "No.",
  addressLabel: "Address",
  pageLabel: "Page",

  // Friendly note printed beside the company name in section 1. Use "" to print nothing.
  companyNote: "With {heart} from **Thu Hien**",

  termsTitle: "Terms & Conditions",
  articleLabel: "Article",

  signature: {
    partyA: "Party A",
    partyB: "Party B",
    hint: "Signature & full name",
  },

  // Signature line under the terms of the tour and Easy Rider agreements.
  acceptance: {
    statement: "Party B has read and accepts these terms.",
    signature: "Signature:",
    date: "Date:",
  },

  // Labels used on more than one form.
  fields: {
    fullName: "Full name",
    birthDate: "Date of birth",
    nationality: "Nationality",
    idNumber: "ID card / Passport No.",
    phoneChat: "Phone (WhatsApp / Zalo)",
    hotel: "Hotel / local address",
    plate: "Licence plate",
    emergencyContact: "Emergency contact (name & phone)",

    duration: "Days / nights",
    start: "Start (time · date)",
    end: "End (time · date)",
    pickupDropoff: "Pick-up & drop-off place",
    included: "Services included",
    other: "Other:",

    totalPrice: "Total price",
    depositPaid: "Deposit paid",
    balanceDue: "Balance due",
    balanceDate: "Balance to be paid by",
    currency: "VND",
    paidBy: "Paid by",
    paymentMethods: ["Cash", "Bank transfer"],
  },

  toolbar: {
    home: "← All agreements",
    print: "Print / Save PDF",
    hint: "A4 · print double-sided",
    overflow: "Content does not fit on page {pages} — shorten the text.",
  },
};
