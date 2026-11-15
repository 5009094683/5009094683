import { Html, html } from '../admin/html';
import type { Business } from '../business/schema';

/*
  The privacy notice of the assistant, in both languages on one page.

  Facebook asks every app for the address of a privacy notice and of a way to
  have one's data deleted before the app may serve the public; this page is
  both (the second with "#delete" at the end of the address).

  It says what this program does: what it stores and where it goes. Read it
  before publishing it, and change it where the company does things otherwise.
  When what the program stores changes, change this page and LAST_CHANGED.
*/

const LAST_CHANGED = { en: '15 November 2026', vi: 'ngày 15 tháng 11 năm 2026' };

const META_POLICY = 'https://www.facebook.com/privacy/policy/';

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         color: #1c1e21; background: #f5f6f7; }
  main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  section { background: #fff; border-radius: 12px; padding: 1.5rem 1.5rem 0.75rem; margin-top: 1.5rem;
            box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 0.25rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 0.25rem; }
  p, ul { margin: 0.5rem 0 1rem; }
  ul { padding-left: 1.25rem; }
  .muted { color: #606770; font-size: 0.9rem; }
  nav { font-size: 0.95rem; }
  a { color: #0a66c2; }
  @media (prefers-color-scheme: dark) {
    body { color: #e4e6eb; background: #18191a; }
    section { background: #242526; box-shadow: none; }
    .muted { color: #b0b3b8; }
    a { color: #6cb4ff; }
  }
`;

export function privacyPage(business: Business): string {
  const company = business.company.name;
  const contacts = business.company.contacts;
  const reach = (lang: 'en' | 'vi') =>
    contacts.length === 0
      ? ''
      : html`${lang === 'en' ? ', or reach us at ' : ', hoặc liên hệ qua '}${contacts
          .map((contact) => `${contact.label} ${contact.value}`)
          .join(lang === 'en' ? ' or ' : ' hoặc ')}`;
  const contactList = html`<p>
    ${company}${contacts.map((contact) => html`<br />${contact.label}: ${contact.value}`)}
  </p>`;

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Privacy notice · ${company}</title>
        <style>
          ${new Html(STYLE)}
        </style>
      </head>
      <body>
        <main>
          <nav><a href="#en">English</a> · <a href="#vi">Tiếng Việt</a></nav>

          <section id="en" lang="en">
            <h1>Privacy notice</h1>
            <p class="muted">
              The booking assistant of ${company} on Messenger · last changed ${LAST_CHANGED.en}
            </p>
            <p>
              ${company} answers messages to its Facebook Page with an automatic booking assistant.
              This notice says what the assistant keeps about you, what for, and how to have it
              deleted.
            </p>

            <h2>What we keep</h2>
            <ul>
              <li>The messages you write to our Page, and our answers.</li>
              <li>Your name as Facebook shows it to our Page.</li>
              <li>
                What you tell us for a booking: what you book, the dates, how many people or
                motorbikes, and a phone number and pick-up place if you give them.
              </li>
            </ul>
            <p>
              Photos, voice messages and files you send stay in Messenger; the assistant only notes
              that something was sent. We receive nothing else from your Facebook profile, and never
              your password.
            </p>

            <h2>What we use it for</h2>
            <p>
              To answer your questions, to take and confirm your booking, and to reach you about it.
              We do not use it for advertising, and we do not sell it or give it to others.
            </p>

            <h2>Who sees it</h2>
            <p>
              The team of ${company}. The messages themselves travel through Messenger, a service of
              Meta, which handles them under <a href="${META_POLICY}">its own privacy policy</a>.
            </p>

            <h2>How long we keep it</h2>
            <p>
              For as long as we need it to look after your booking and for our own records, or until
              you ask us to delete it.
            </p>

            <h2 id="delete">Having your data deleted</h2>
            <p>
              Write “delete my data” to our Page on Messenger${reach('en')}. We then delete your
              chat with the assistant. The details of a booking (name, phone number, dates) stay in
              our booking records for as long as we need them for the trip and for our accounts;
              tell us if you want those removed as well. You can also delete the conversation in
              Messenger yourself, and block our Page, at any time.
            </p>

            <h2>Contact</h2>
            ${contactList}
          </section>

          <section id="vi" lang="vi">
            <h1>Thông báo về quyền riêng tư</h1>
            <p class="muted">
              Trợ lý đặt chỗ của ${company} trên Messenger · cập nhật ${LAST_CHANGED.vi}
            </p>
            <p>
              ${company} trả lời tin nhắn gửi đến Trang Facebook của mình bằng một trợ lý đặt chỗ tự
              động. Thông báo này cho biết trợ lý lưu những gì về anh/chị, để làm gì, và cách yêu
              cầu xóa.
            </p>

            <h2>Chúng tôi lưu những gì</h2>
            <ul>
              <li>Tin nhắn anh/chị gửi cho Trang và câu trả lời của chúng tôi.</li>
              <li>Tên của anh/chị như Facebook hiển thị cho Trang.</li>
              <li>
                Thông tin anh/chị cung cấp để đặt chỗ: dịch vụ, ngày, số người hoặc số xe, và số
                điện thoại, điểm đón nếu anh/chị cung cấp.
              </li>
            </ul>
            <p>
              Ảnh, tin nhắn thoại và tệp anh/chị gửi vẫn nằm trong Messenger; trợ lý chỉ ghi nhận là
              có tệp được gửi. Chúng tôi không nhận thêm thông tin nào khác từ trang cá nhân
              Facebook của anh/chị, và không bao giờ nhận mật khẩu.
            </p>

            <h2>Dùng để làm gì</h2>
            <p>
              Để trả lời câu hỏi, nhận và xác nhận đặt chỗ, và liên hệ với anh/chị về việc đặt chỗ
              đó. Chúng tôi không dùng thông tin này để quảng cáo, không bán và không chuyển cho bên
              khác.
            </p>

            <h2>Ai xem được</h2>
            <p>
              Nhân viên của ${company}. Tin nhắn được gửi qua Messenger, dịch vụ của Meta, theo
              <a href="${META_POLICY}">chính sách quyền riêng tư riêng của Meta</a>.
            </p>

            <h2>Lưu trong bao lâu</h2>
            <p>
              Trong thời gian cần thiết để phục vụ việc đặt chỗ và lưu sổ sách của chúng tôi, hoặc
              đến khi anh/chị yêu cầu xóa.
            </p>

            <h2 id="xoa">Yêu cầu xóa dữ liệu</h2>
            <p>
              Nhắn “xóa dữ liệu của tôi” cho Trang trên Messenger${reach('vi')}. Chúng tôi sẽ xóa
              cuộc trò chuyện của anh/chị với trợ lý. Thông tin đặt chỗ (tên, số điện thoại, ngày)
              được giữ trong sổ đặt chỗ trong thời gian cần cho chuyến đi và sổ sách; hãy cho chúng
              tôi biết nếu anh/chị muốn xóa cả phần này. Anh/chị cũng có thể tự xóa cuộc trò chuyện
              trong Messenger và chặn Trang bất cứ lúc nào.
            </p>

            <h2>Liên hệ</h2>
            ${contactList}
          </section>
        </main>
      </body>
    </html>`.text;
}
