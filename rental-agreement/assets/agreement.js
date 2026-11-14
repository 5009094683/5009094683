(function () {
  "use strict";

  const config = window.AGREEMENT_CONFIG || {};
  const company = config.company || {};
  const contacts = company.contacts || [];
  const commonWording = window.AGREEMENT_COMMON || {};
  const ownWording = window.AGREEMENT_CONTENT || {};
  const languages = Object.keys(ownWording);
  const root = document.documentElement;
  const pages = Array.from(document.querySelectorAll(".page"));

  const MIN_FIT = 0.86;
  const FIT_STEP = 0.02;

  const BLANK = '<span class="blank"></span>';
  // Drawn rather than typed so it prints the same on every computer, whatever fonts it has.
  const HEART =
    '<svg class="heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.4C7.6 17.6 2.2 13.6 2.2 8.5A5.2 5.2 0 0 1 12 6.1 5.2 5.2 0 0 1 21.8 8.5C21.8 13.6 16.4 17.6 12 21.4Z"/></svg>';
  const GUIDES = {
    time: "<i></i><b>:</b><i></i>",
    date: '<i></i>/<i></i>/<i class="wide"></i>',
  };

  // Built-in emblem (mountains and a winding road), used when config.js has no logo.
  const EMBLEM = `
    <svg class="defs" aria-hidden="true">
      <clipPath id="emblem-clip"><circle cx="24" cy="24" r="24"/></clipPath>
      <symbol id="emblem" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="24" fill="currentColor"/>
        <g fill="#fff" clip-path="url(#emblem-clip)">
          <circle cx="35.5" cy="12.5" r="3" opacity=".9"/>
          <path d="M1 34C6 25 9.5 18 13 18s7 7 10 16Z" opacity=".5"/>
          <path d="M26 34c3.5-6.5 6.5-11 9.5-11S42 28 47 34Z" opacity=".5"/>
          <path d="M11 34C16 21.5 20 10.5 24 10.5S32 21.5 37 34Z"/>
          <path d="M23.2 33.5C23.2 36.6 29 36.4 29 39.2 29 42.3 17.5 42.5 15 49H27C27.5 44.5 34 43.5 34 39.2 34 35.4 24.8 36 24.8 33.5Z"/>
        </g>
        <circle cx="24" cy="24" r="23.3" fill="none" stroke="currentColor" stroke-width="1.4"/>
      </symbol>
    </svg>`;

  // Shown on screen only, above the pages.
  const TOOLBAR = `
    <div class="toolbar">
      <a class="toolbar-home" href="index.html" data-t="toolbar.home"></a>
      <div class="toolbar-languages" id="language-switch"></div>
      <span class="toolbar-warning" id="overflow-warning" hidden></span>
      <span class="toolbar-hint" data-t="toolbar.hint"></span>
      <button type="button" id="print-button" data-t="toolbar.print"></button>
    </div>`;

  // Blocks that look the same in every agreement. A page asks for one with data-part="name".
  const PARTS = {
    brand: `
      <div class="brand-identity">
        <span class="brand-logo"></span>
        <div>
          <div class="brand-name" data-c="company.name"></div>
          <div class="brand-tagline" data-t="tagline"></div>
        </div>
      </div>
      <dl class="brand-contacts" data-contacts></dl>`,

    "brand-compact": `
      <div class="brand-identity">
        <span class="brand-logo"></span>
        <div class="brand-name" data-c="company.name"></div>
      </div>
      <div class="running-title" data-t="title"></div>`,

    masthead: `
      <div class="national" data-if="showNationalHeader">
        <div class="national-name" data-t="nationalName"></div>
        <div class="national-motto" data-t="nationalMotto"></div>
      </div>
      <h1 class="title" data-t="title"></h1>
      <div class="agreement-number" data-if="showAgreementNumber">
        <span data-t="agreementNumber"></span><span class="blank"></span>
      </div>`,

    "party-a": `
      <div>
        <div class="party-a-name" data-c="company.name"></div>
        <div class="party-a-address" data-if="hasAddress">
          <span data-t="addressLabel"></span>: <b data-c="company.address"></b>
        </div>
      </div>
      <div class="party-a-note" data-t="companyNote"></div>`,

    signatures: `
      <div class="signature">
        <div class="signature-party"><strong data-t="signature.partyA"></strong><span data-t="signature.roleA"></span></div>
        <div class="signature-hint" data-t="signature.hint"></div>
      </div>
      <div class="signature">
        <div class="signature-party"><strong data-t="signature.partyB"></strong><span data-t="signature.roleB"></span></div>
        <div class="signature-hint" data-t="signature.hint"></div>
      </div>`,

    acceptance: `
      <span class="acceptance-statement" data-t="acceptance.statement"></span>
      <span class="acceptance-field acceptance-signature"><span data-t="acceptance.signature"></span><span class="blank"></span></span>
      <span class="acceptance-field"><span data-t="acceptance.date"></span><span class="guide" data-guide="date"></span></span>`,
  };

  const flags = {
    showNationalHeader: config.showNationalHeader !== false,
    showAgreementNumber: config.showAgreementNumber !== false,
    hasBikeModels: Array.isArray(config.bikeModels) && config.bikeModels.length > 0,
    hasAddress: Boolean(company.address),
  };

  const all = (selector) => Array.from(document.querySelectorAll(selector));

  const lookup = (source, path) =>
    path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), source);

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

  const isGroup = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  // Line by line, an agreement's own wording wins over the wording shared by all agreements.
  function merge(shared, own) {
    const result = { ...shared };
    Object.keys(own).forEach((key) => {
      result[key] =
        isGroup(shared[key]) && isGroup(own[key]) ? merge(shared[key], own[key]) : own[key];
    });
    return result;
  }

  const contents = {};
  languages.forEach((language) => {
    contents[language] = merge(commonWording[language] || {}, ownWording[language]);
  });

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
        else if (key === "heart") filled = HEART;
        else if (typeof value === "number" || value === null) filled = amount(value, text);
        else return match;
        return (before && "&nbsp;") + filled + (after && "&nbsp;");
      });
  }

  function contactsHtml() {
    return contacts
      .map((contact) => `<dt>${escapeHtml(contact.label)}</dt><dd>${escapeHtml(contact.value)}</dd>`)
      .join("");
  }

  // A list comes from the wording files, or from config.js when it is the same in every language.
  function listItems(path, text) {
    const items = lookup(text, path) ?? lookup(config, path);
    return Array.isArray(items) ? items : [];
  }

  // data-other="..." adds a last entry with a line to write on.
  function otherLabel(element, text) {
    const label = element.dataset.other && lookup(text, element.dataset.other);
    return label ? rich(label, text) : "";
  }

  function ticksHtml(element, text) {
    const items = listItems(element.dataset.ticks, text).map(
      (item) => `<span class="check"><i class="box"></i><span>${rich(item, text)}</span></span>`
    );
    const other = otherLabel(element, text);
    if (other) items.push(`<span class="check write-in"><i class="box"></i>${other}${BLANK}</span>`);
    return items.join("");
  }

  function countsHtml(element, text) {
    const items = listItems(element.dataset.counts, text).map(
      (item) => `<span class="count"><i class="count-box"></i>${rich(item, text)}</span>`
    );
    const other = otherLabel(element, text);
    if (other) items.push(`<span class="write-in">${other}${BLANK}</span>`);
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
      <b>${escapeHtml(company.name || "")}</b>
      <div class="page-number">${escapeHtml(text.pageLabel)} ${pageNumber}/${pages.length}</div>`;
  }

  // The language comes from the address, e.g. tour-package.html#en; the first loaded one is the default.
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
    document.title = [text.title, company.name].filter(Boolean).join(" – ");

    all("[data-t]").forEach((element) => {
      const value = lookup(text, element.dataset.t);
      element.innerHTML = value == null ? "" : rich(value, text);
    });
    all("[data-ticks]").forEach((element) => {
      element.innerHTML = ticksHtml(element, text);
    });
    all("[data-counts]").forEach((element) => {
      element.innerHTML = countsHtml(element, text);
    });
    all("#terms").forEach((element) => {
      element.innerHTML = termsHtml(text);
    });
    pages.forEach((page, index) => {
      page.querySelector(".page-footer").innerHTML = footerHtml(text, index + 1);
    });
    all("#language-switch button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    });

    fitPages();
  }

  // Everything that does not depend on the language. Also used by the start page (index.html).
  function setupBrand() {
    if (config.accentColor) root.style.setProperty("--accent", config.accentColor);

    document.body.insertAdjacentHTML("afterbegin", EMBLEM);

    // A misspelt part name is printed on the page so it is easy to spot.
    all("[data-part]").forEach((element) => {
      const name = element.dataset.part;
      element.innerHTML = PARTS[name] || escapeHtml(`[data-part="${name}"?]`);
    });

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

    all("[data-c]").forEach((element) => {
      element.textContent = lookup(config, element.dataset.c) || "";
    });
    all("[data-contacts]").forEach((element) => {
      element.innerHTML = contactsHtml();
    });
  }

  function setupAgreement() {
    document.body.insertAdjacentHTML("afterbegin", TOOLBAR);
    pages.forEach((page) => {
      page.insertAdjacentHTML("beforeend", '<footer class="page-footer"></footer>');
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

  if (pages.length === 0) {
    setupBrand();
    return;
  }
  if (languages.length === 0) {
    document.body.textContent = "No <agreement>.<language>.js wording file is loaded on this page.";
    return;
  }
  setupBrand();
  setupAgreement();
})();
