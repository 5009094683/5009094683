(function () {
  "use strict";

  const config = window.AGREEMENT_CONFIG || {};
  const contents = window.AGREEMENT_CONTENT || {};
  const company = config.company || {};
  const contacts = company.contacts || [];
  const languages = Object.keys(contents);
  const root = document.documentElement;
  const pages = Array.from(document.querySelectorAll(".page"));

  const MIN_FIT = 0.86;
  const FIT_STEP = 0.02;

  const BLANK = '<span class="blank"></span>';
  const GUIDES = {
    time: "<i></i><b>:</b><i></i>",
    date: '<i></i>/<i></i>/<i class="wide"></i>',
  };

  const flags = {
    showNationalHeader: config.showNationalHeader !== false,
    showAgreementNumber: config.showAgreementNumber !== false,
    hasBikeModels: Array.isArray(config.bikeModels) && config.bikeModels.length > 0,
  };

  const all = (selector) => Array.from(document.querySelectorAll(selector));

  const lookup = (source, path) =>
    path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), source);

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

  function amount(value, text) {
    if (value === null) return BLANK;
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, text.thousandsSeparator);
  }

  // Unknown {placeholders} are left visible on purpose so typos are easy to spot.
  // Spaces around a filled placeholder become non-breaking so "label: ____ VND" stays on one line.
  function rich(raw, text) {
    return escapeHtml(raw)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/( ?)\{(\w+)\}( ?)/g, (match, before, key, after) => {
        const value = config[key];
        let filled;
        if (key === "blank") filled = BLANK;
        else if (typeof value === "number" || value === null) filled = amount(value, text);
        else return match;
        return (before && "&nbsp;") + filled + (after && "&nbsp;");
      });
  }

  function contactsStacked() {
    return contacts
      .map((contact) => `<dt>${escapeHtml(contact.label)}</dt><dd>${escapeHtml(contact.value)}</dd>`)
      .join("");
  }

  function contactsInline(text, withAddress) {
    const parts = contacts.map(
      (contact) => `${escapeHtml(contact.label)}: <b>${escapeHtml(contact.value)}</b>`
    );
    if (withAddress && company.address) {
      parts.push(`${escapeHtml(text.addressLabel)}: <b>${escapeHtml(company.address)}</b>`);
    }
    return parts.map((part) => `<span class="contact">${part}</span>`).join("");
  }

  function bikeModelsHtml(text) {
    const boxes = (config.bikeModels || []).map(
      (model) => `<span class="check"><i class="box"></i>${escapeHtml(model)}</span>`
    );
    boxes.push(
      `<span class="check write-in"><i class="box"></i>${escapeHtml(text.fields.otherModel)}${BLANK}</span>`
    );
    return boxes.join("");
  }

  function accessoriesHtml(text) {
    const items = (text.fields.accessoryItems || []).map(
      (item) => `<span class="count"><i class="count-box"></i>${escapeHtml(item)}</span>`
    );
    items.push(`<span class="write-in">${escapeHtml(text.fields.otherAccessory)}${BLANK}</span>`);
    return items.join("");
  }

  function clauseHtml(clause, text) {
    if (typeof clause === "string") return `<li>${rich(clause, text)}</li>`;
    const items = (clause.items || []).map((item) => `<li>${rich(item, text)}</li>`).join("");
    return `<li>${rich(clause.text, text)}${items ? `<ul>${items}</ul>` : ""}</li>`;
  }

  function termsHtml(text) {
    return (text.articles || [])
      .map(
        (article, index) => `
          <article class="article">
            <div class="article-number"><span>${escapeHtml(text.articleLabel)}</span><b>${index + 1}</b></div>
            <div>
              <h2 class="article-title">${rich(article.title, text)}</h2>
              <ol class="clauses">${article.clauses.map((clause) => clauseHtml(clause, text)).join("")}</ol>
            </div>
          </article>`
      )
      .join("");
  }

  function footerHtml(text, pageNumber) {
    return `
      <div class="page-footer-contacts"><b>${escapeHtml(company.name || "")}</b>${contactsInline(text, false)}</div>
      <div class="page-number">${escapeHtml(text.pageLabel)} ${pageNumber}/${pages.length}</div>`;
  }

  // The language comes from the address, e.g. agreement.html#en; the first loaded one is the default.
  function currentLanguage() {
    const requested = location.hash.slice(1);
    return languages.includes(requested) ? requested : languages[0];
  }

  function overflows(page) {
    const limit =
      page.getBoundingClientRect().bottom - parseFloat(getComputedStyle(page).paddingBottom);
    return page.lastElementChild.getBoundingClientRect().bottom > limit + 0.5;
  }

  // When content is added (more clauses, an address, bike models...) the page is compacted
  // step by step through the --fit variable in agreement.css until everything fits again.
  function fitPage(page) {
    let fit = 1;
    page.style.removeProperty("--fit");
    while (overflows(page) && fit - FIT_STEP >= MIN_FIT - 0.001) {
      fit -= FIT_STEP;
      page.style.setProperty("--fit", fit.toFixed(2));
    }
    return !overflows(page);
  }

  function fitPages() {
    const text = contents[currentLanguage()];
    const overflowing = [];
    pages.forEach((page, index) => {
      const fits = fitPage(page);
      page.toggleAttribute("data-overflow", !fits);
      if (!fits) overflowing.push(index + 1);
    });

    // build-pdf.mjs reads this attribute to report pages that do not fit.
    if (overflowing.length) root.setAttribute("data-overflow", overflowing.join(","));
    else root.removeAttribute("data-overflow");

    const warning = document.getElementById("overflow-warning");
    warning.hidden = overflowing.length === 0;
    warning.textContent = text.toolbar.overflow.replace("{pages}", overflowing.join(", "));
  }

  function render() {
    const language = currentLanguage();
    const text = contents[language];

    root.lang = language;
    document.title = [text.fileTitle, company.name].filter(Boolean).join(" – ");

    all("[data-t]").forEach((element) => {
      const value = lookup(text, element.dataset.t);
      element.innerHTML = value == null ? "" : rich(value, text);
    });
    all("[data-c]").forEach((element) => {
      element.textContent = lookup(config, element.dataset.c) || "";
    });
    all('[data-contacts="stacked"]').forEach((element) => {
      element.innerHTML = contactsStacked();
    });
    all('[data-contacts="inline"]').forEach((element) => {
      element.innerHTML = contactsInline(text, true);
    });
    all('[data-list="bikeModels"]').forEach((element) => {
      element.innerHTML = bikeModelsHtml(text);
    });
    all('[data-list="accessories"]').forEach((element) => {
      element.innerHTML = accessoriesHtml(text);
    });
    document.getElementById("terms").innerHTML = termsHtml(text);
    pages.forEach((page, index) => {
      page.querySelector(".page-footer").innerHTML = footerHtml(text, index + 1);
    });
    all("#language-switch button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    });

    fitPages();
  }

  function setup() {
    if (config.accentColor) root.style.setProperty("--accent", config.accentColor);

    // data-if="name" keeps an element when that option is on, data-if="!name" when it is off.
    // Any true/false setting added to config.js can be used as a name.
    const isOn = (name) => (name in flags ? flags[name] : Boolean(config[name]));
    all("[data-if]").forEach((element) => {
      const condition = element.dataset.if;
      const wanted = condition.startsWith("!") ? !isOn(condition.slice(1)) : isOn(condition);
      if (!wanted) element.remove();
    });

    all("[data-guide]").forEach((element) => {
      element.innerHTML = GUIDES[element.dataset.guide] || "";
    });

    all(".brand-logo").forEach((element) => {
      element.innerHTML = company.logo
        ? `<img src="${escapeHtml(company.logo)}" alt="">`
        : '<svg viewBox="0 0 48 48" aria-hidden="true"><use href="#emblem"/></svg>';
    });

    document.getElementById("language-switch").innerHTML = languages
      .map(
        (language) =>
          `<button type="button" data-language="${escapeHtml(language)}">${escapeHtml(
            contents[language].languageName || language
          )}</button>`
      )
      .join("");
    all("#language-switch button").forEach((button) => {
      button.addEventListener("click", () => {
        location.hash = button.dataset.language;
      });
    });

    document.getElementById("print-button").addEventListener("click", () => window.print());
    window.addEventListener("hashchange", render);

    render();

    // Fonts and a custom logo change the layout once they finish loading, so measure again.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitPages);
    window.addEventListener("load", fitPages);
  }

  if (languages.length === 0) {
    document.body.textContent = "No content.<language>.js file is loaded in agreement.html.";
    return;
  }
  setup();
})();
