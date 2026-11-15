/*
  LỜI VĂN TIẾNG VIỆT của mọi câu trợ lý nói với khách.

  Sửa câu ở đây rồi khởi động lại; câu tiếng Anh tương ứng nằm trong en.ts.
  Chỉ viết văn bản thuần, không định dạng: Messenger hiển thị đúng như đã viết.
*/
import { formatMoney } from '../../bookings/pricing';
import type { Business, ServiceKind } from '../../business/schema';
import { formatDate } from '../../nlu/dates';
import type { BookingStatus } from '../../store';
import type { BookingView, Wording } from './types';

const money = (amount: number) => formatMoney(amount, 'vi');
const date = (day: string) => formatDate(day, 'vi');

const UNIT: Record<ServiceKind, { word: string; label: string; per: string; perLong: string }> = {
  rental: { word: 'xe', label: 'Số xe', per: '/xe/ngày', perLong: 'mỗi xe mỗi ngày' },
  tour: { word: 'người', label: 'Số người', per: '/người', perLong: 'mỗi người' },
  easy_rider: { word: 'khách', label: 'Số khách', per: '/khách/ngày', perLong: 'mỗi khách mỗi ngày' },
}; // prettier-ignore

const STATUS: Record<BookingStatus, string> = {
  pending: 'đang chờ nhân viên xác nhận',
  confirmed: 'đã xác nhận',
  declined: 'chưa nhận được',
  cancelled: 'đã huỷ',
};

function list(items: string[], last: string): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}

function menu(business: Business): string {
  return business.services.map((service, i) => `${i + 1}. ${service.name.vi}`).join('\n');
}

function contactLine(business: Business): string {
  const contacts = business.company.contacts.map((c) => `${c.label} ${c.value}`);
  return contacts.length > 0 ? ` Anh/chị cũng có thể liên hệ qua ${list(contacts, 'hoặc')}.` : '';
}

function priceLine(view: BookingView): string {
  if (view.total === null) return 'Giá: nhân viên bên em sẽ báo giá cho anh/chị.';
  if (view.unitPrice === null) return `Giá: ${money(view.total)}`;
  const units = `${view.quantity} ${UNIT[view.kind].word}`;
  const days = view.kind === 'tour' ? '' : ` × ${view.days} ngày`;
  return `Giá: ${money(view.unitPrice)} × ${units}${days} = ${money(view.total)}`;
}

function details(view: BookingView): string[] {
  const lines = [
    `Dịch vụ: ${view.serviceName}${view.optionName ? ` – ${view.optionName}` : ''}`,
    view.days === 1
      ? `Ngày: ${date(view.startDate)} (1 ngày)`
      : `Thời gian: ${date(view.startDate)} đến ${date(view.endDate)} (${view.days} ngày)`,
    `${UNIT[view.kind].label}: ${view.quantity}`,
    `Tên: ${view.name}`,
  ];
  if (view.phone) lines.push(`Điện thoại: ${view.phone}`);
  if (view.pickup) lines.push(`${view.kind === 'rental' ? 'Nơi ở' : 'Điểm đón'}: ${view.pickup}`);
  lines.push(priceLine(view));
  return lines;
}

function depositLine(view: BookingView, business: Business): string {
  if (view.depositPercent <= 0) return '';
  const methods = list(business.payment.methods.vi, 'hoặc');
  const how = methods ? ` bằng ${methods}` : '';
  const instructions =
    business.payment.instructions.vi || 'Nhân viên bên em sẽ gửi thông tin thanh toán tại đây.';
  const amount = view.deposit === null ? '' : ` (${money(view.deposit)})`;
  return (
    `Đặt cọc: anh/chị vui lòng thanh toán ${view.depositPercent}%${amount}${how} để giữ chỗ; ` +
    `phần còn lại thanh toán trước khi khởi hành. ${instructions}`
  );
}

export const vi: Wording = {
  welcome: (business) =>
    `Xin chào anh/chị! Em là trợ lý đặt chỗ tự động của ${business.company.name}. Em có thể hỗ trợ anh/chị:\n` +
    `${menu(business)}\n` +
    'Anh/chị cho em biết mình cần gì và vào ngày nào nhé, ví dụ “2 xe máy, 3 ngày từ 20/11”. ' +
    'Để gặp nhân viên, anh/chị nhắn “nhân viên”.',

  intro: (business) =>
    `Xin chào anh/chị! Em là trợ lý đặt chỗ tự động của ${business.company.name}. Để gặp nhân viên, anh/chị nhắn “nhân viên”.`,

  askService: (business) => `Anh/chị muốn đặt dịch vụ nào ạ?\n${menu(business)}`,

  askOption: (service) => {
    const question: Record<ServiceKind, string> = {
      rental: 'Anh/chị muốn thuê xe nào ạ?',
      tour: 'Anh/chị muốn đi tour nào ạ?',
      easy_rider: 'Anh/chị chọn lựa chọn nào ạ?',
    };
    const options = service.options.map((option, i) => {
      const price =
        option.price === null ? '' : ` – ${money(option.price)}${UNIT[service.kind].per}`;
      return `${i + 1}. ${option.name.vi}${price}`;
    });
    return `${question[service.kind]}\n${options.join('\n')}`;
  },

  askStartDate: (kind) =>
    ({
      rental: 'Anh/chị cần xe từ ngày nào ạ? (ví dụ 20/11)',
      tour: 'Anh/chị muốn khởi hành ngày nào ạ? (ví dụ 20/11)',
      easy_rider: 'Anh/chị muốn đi từ ngày nào ạ? (ví dụ 20/11)',
    })[kind],

  askDays: (kind) =>
    ({
      rental: 'Anh/chị thuê mấy ngày ạ?',
      tour: 'Anh/chị muốn đi tour mấy ngày ạ?',
      easy_rider: 'Anh/chị đi mấy ngày ạ?',
    })[kind],

  askQuantity: (kind) =>
    ({
      rental: 'Anh/chị cần mấy xe ạ?',
      tour: 'Đoàn mình có mấy người ạ?',
      easy_rider: 'Có mấy khách đi ạ? (mỗi khách đi cùng một tài xế riêng)',
    })[kind],

  askName: () => 'Anh/chị cho em xin tên để đặt chỗ ạ?',

  askPhone: () =>
    'Anh/chị cho em xin số điện thoại (Zalo hoặc WhatsApp) để tiện liên hệ ạ? ' +
    'Nếu chỉ muốn liên lạc qua Messenger, anh/chị nhắn “bỏ qua”.',

  askPickup: (kind) =>
    kind === 'rental'
      ? 'Anh/chị đang ở đâu ạ? (tên khách sạn hoặc địa chỉ, hoặc nhắn “bỏ qua”)'
      : 'Bên em đón anh/chị ở đâu ạ? (tên khách sạn hoặc địa chỉ, hoặc nhắn “bỏ qua”)',

  summary: (view) => {
    const deposit =
      view.depositPercent > 0
        ? `\nKhi xác nhận, bên em xin đặt cọc ${view.depositPercent}%${view.deposit === null ? '' : ` (${money(view.deposit)})`}.`
        : '';
    return `Anh/chị kiểm tra giúp em thông tin đặt chỗ:\n${details(view).join('\n')}${deposit}\n\nAnh/chị nhắn “ĐỒNG Ý” để đặt, hoặc cho em biết cần sửa gì ạ.`;
  },

  remindConfirm: () => 'Anh/chị nhắn “ĐỒNG Ý” để đặt, hoặc cho em biết cần sửa gì ạ.',

  whatToChange: (kind) =>
    `Dạ được ạ. Anh/chị muốn sửa thông tin nào? (ví dụ ngày, số ngày hoặc số ${UNIT[kind].word})`,

  bookingReceived: (view) =>
    `Cảm ơn anh/chị ${view.name}! Yêu cầu ${view.code} đã được chuyển cho nhân viên bên em. ` +
    (view.total === null
      ? 'Nhân viên sẽ xác nhận và báo giá tại đây trong thời gian sớm nhất.'
      : 'Nhân viên sẽ xác nhận tại đây trong thời gian sớm nhất.'),

  bookingConfirmed: (view, business, service) => {
    const parts = [`Đặt chỗ ${view.code} của anh/chị đã được xác nhận.`, details(view).join('\n')];
    const deposit = depositLine(view, business);
    if (deposit) parts.push(deposit);
    const terms = service ? vi.cancellationOf(service) : '';
    if (terms) parts.push(terms);
    parts.push(
      view.kind === 'rental'
        ? 'Anh/chị vui lòng mang theo hộ chiếu hoặc căn cước công dân và giấy phép lái xe.'
        : 'Anh/chị vui lòng mang theo hộ chiếu hoặc căn cước công dân bản gốc (bắt buộc ở khu vực biên giới).',
    );
    const signature = business.company.signature
      ? `${business.company.signature}, ${business.company.name}`
      : business.company.name;
    parts.push(`Cảm ơn anh/chị, hẹn gặp anh/chị vào ${date(view.startDate)}!\n${signature}`);
    return parts.join('\n\n');
  },

  bookingDeclined: (code, note) =>
    `Rất tiếc, bên em chưa thể nhận đặt chỗ ${code}.${note ? ` ${note}` : ''}\n` +
    'Nếu anh/chị đi được ngày khác, anh/chị nhắn để em kiểm tra giúp ạ.',

  bookingCancelled: (code, note) =>
    `Đặt chỗ ${code} của anh/chị đã được huỷ.${note ? ` ${note}` : ''}\n` +
    'Khi nào cần đặt lại, anh/chị cứ nhắn em ạ.',

  prices: (service) => {
    const unit = UNIT[service.kind];
    const note = service.note.vi ? `\n${service.note.vi}` : '';
    const priced = service.options.filter((option) => option.price !== null);
    if (priced.length === 0) {
      return `${service.name.vi}: nhân viên bên em sẽ báo giá theo ngày anh/chị đi.${note}`;
    }
    if (service.options.length === 1) {
      return `${service.name.vi}: ${money(priced[0]!.price!)}${unit.per}.${note}`;
    }
    const lines = service.options.map(
      (option) =>
        `- ${option.name.vi}: ${option.price === null ? 'nhân viên sẽ báo giá' : money(option.price)}`,
    );
    return `${service.name.vi}, giá ${unit.perLong}:\n${lines.join('\n')}${note}`;
  },

  offerToBook: () => 'Anh/chị có muốn đặt luôn không ạ? Anh/chị cho em biết ngày và số lượng nhé.',

  included: (service) => {
    const note = service.note.vi ? ` ${service.note.vi}` : '';
    if (service.included.vi.length === 0) {
      return `${service.name.vi} bao gồm những gì tuỳ theo chuyến đi; nhân viên bên em sẽ gửi chi tiết cho anh/chị.${note}`;
    }
    return `${service.name.vi} bao gồm: ${list(service.included.vi, 'và')}.${note}`;
  },

  payment: (business) => {
    const parts: string[] = [];
    const methods = list(business.payment.methods.vi, 'hoặc');
    if (methods) parts.push(`Anh/chị có thể thanh toán bằng ${methods}.`);
    const byPercent = new Map<number, string[]>();
    for (const service of business.services) {
      if (service.depositPercent <= 0) continue;
      byPercent.set(service.depositPercent, [
        ...(byPercent.get(service.depositPercent) ?? []),
        service.name.vi,
      ]);
    }
    for (const [percent, names] of byPercent) {
      parts.push(
        `Với ${list(names, 'và')}, anh/chị đặt cọc ${percent}% để xác nhận, phần còn lại thanh toán trước khi khởi hành.`,
      );
    }
    if (business.payment.instructions.vi) parts.push(business.payment.instructions.vi);
    if (parts.length === 0) parts.push('Nhân viên bên em sẽ gửi thông tin thanh toán cho anh/chị.');
    return parts.join(' ');
  },

  cancellationOf: (service) => {
    const terms = service.cancellation;
    if (!terms) return '';
    return (
      `Huỷ chỗ: miễn phí nếu báo trước giờ khởi hành từ ${terms.freeHours} tiếng trở lên; ` +
      `từ ${terms.lateHours} đến dưới ${terms.freeHours} tiếng, thu ${terms.midChargePercent}% tổng giá; ` +
      `dưới ${terms.lateHours} tiếng hoặc không đến, thu 100%.`
    );
  },

  cancellation: (business) => {
    const byTerms = new Map<string, string[]>();
    const without: string[] = [];
    for (const service of business.services) {
      const terms = vi.cancellationOf(service);
      if (!terms) without.push(service.name.vi);
      else byTerms.set(terms, [...(byTerms.get(terms) ?? []), service.name.vi]);
    }
    const parts = [...byTerms].map(([terms, names]) => `${list(names, 'và')}. ${terms}`);
    if (without.length > 0) {
      parts.push(
        `${list(without, 'và')}: nhân viên bên em sẽ tư vấn điều kiện. Anh/chị nhắn “nhân viên” để hỏi ạ.`,
      );
    }
    return parts.join('\n');
  },

  documents: () =>
    'Anh/chị vui lòng mang theo hộ chiếu hoặc căn cước công dân bản gốc (bắt buộc ở khu vực biên giới). ' +
    'Khi thuê xe máy, giấy phép lái xe của anh/chị cũng được ghi vào hợp đồng thuê xe.',

  contact: (business) => {
    const contacts = business.company.contacts.map((c) => `${c.label}: ${c.value}`);
    return contacts.length > 0
      ? `Anh/chị có thể liên hệ bên em qua:\n${contacts.join('\n')}`
      : 'Anh/chị nhắn “nhân viên”, nhân viên bên em sẽ trả lời ngay tại đây ạ.';
  },

  location: (business) => {
    const address = business.company.address.vi;
    if (!address) return 'Nhân viên bên em sẽ gửi vị trí chính xác cho anh/chị tại đây ạ.';
    return `Địa chỉ bên em: ${address}${business.company.mapUrl ? `\n${business.company.mapUrl}` : ''}`;
  },

  status: (bookings) => {
    const lines = bookings.map(
      (booking) =>
        `- ${booking.code}: ${booking.serviceName}, ${date(booking.startDate)}, ` +
        `${booking.days} ngày: ${STATUS[booking.status]}`,
    );
    return `Các đặt chỗ của anh/chị:\n${lines.join('\n')}`;
  },

  statusWord: (status) => STATUS[status],

  noBookings: () =>
    'Em chưa tìm thấy đặt chỗ nào trong cuộc trò chuyện này. Nếu anh/chị đã đặt qua kênh khác, ' +
    'anh/chị nhắn “nhân viên” để bên em kiểm tra ạ.',

  handoff: (business) =>
    `Em đã báo nhân viên vào hỗ trợ. Nhân viên sẽ trả lời anh/chị tại đây trong thời gian sớm nhất.${contactLine(business)}`,

  handoffConfused: (business) =>
    `Em chưa hiểu rõ ý anh/chị nên đã báo nhân viên vào hỗ trợ. Nhân viên sẽ trả lời anh/chị tại đây trong thời gian sớm nhất.${contactLine(business)}`,

  needsPerson: (business) =>
    `Với yêu cầu như thế này, nhân viên bên em sẽ trực tiếp sắp xếp nên em đã báo nhân viên vào hỗ trợ. Nhân viên sẽ trả lời anh/chị tại đây trong thời gian sớm nhất.${contactLine(business)}`,

  discount: () =>
    'Giá ưu đãi do nhân viên bên em quyết định. Em đã báo nhân viên, nhân viên sẽ trả lời anh/chị tại đây. ' +
    'Trong lúc chờ, em vẫn có thể nhận đặt chỗ cho anh/chị ạ.',

  cancelRequest: (booking, terms) =>
    (booking
      ? `Em đã chuyển yêu cầu huỷ đặt chỗ ${booking.code} cho nhân viên. Nhân viên sẽ xác nhận với anh/chị tại đây.`
      : 'Em đã chuyển yêu cầu của anh/chị cho nhân viên. Nhân viên sẽ trả lời tại đây.') +
    (terms ? `\n${terms}` : ''),

  changeRequest: (booking) =>
    booking
      ? `Em đã chuyển yêu cầu đổi đặt chỗ ${booking.code} cho nhân viên. Nhân viên sẽ trả lời anh/chị tại đây.`
      : 'Em đã chuyển yêu cầu của anh/chị cho nhân viên. Nhân viên sẽ trả lời tại đây.',

  deleteRequest: () =>
    'Em đã chuyển yêu cầu của anh/chị cho nhân viên. Nhân viên sẽ xóa cuộc trò chuyện của anh/chị với em và báo lại tại đây khi xong ạ.',

  notUnderstood: (business) =>
    'Xin lỗi anh/chị, em chưa hiểu ý ạ. Em có thể hỗ trợ đặt:\n' +
    `${menu(business)}\n` +
    'Ví dụ: “2 xe máy, 3 ngày từ 20/11”. Để gặp nhân viên, anh/chị nhắn “nhân viên”.',

  sorry: () => 'Xin lỗi anh/chị, em chưa hiểu ạ.',

  draftDropped: () => 'Dạ vâng, em đã bỏ yêu cầu đang đặt. Khi nào cần, anh/chị cứ nhắn em ạ.',

  dateInPast: (day) => `Ngày ${date(day)} đã qua rồi ạ.`,

  dateTooFar: (maxAdvanceDays) => `Bên em nhận đặt trước tối đa ${maxAdvanceDays} ngày ạ.`,

  full: (kind, left) =>
    left > 0
      ? `Rất tiếc, những ngày đó bên em chỉ còn ${left} ${UNIT[kind].word}. ` +
        'Anh/chị chọn ngày khác hoặc giảm số lượng được không ạ? Anh/chị cũng có thể nhắn “nhân viên” để hỏi trực tiếp.'
      : 'Rất tiếc, những ngày đó bên em đã kín chỗ. Anh/chị chọn ngày khác được không ạ? Anh/chị cũng có thể nhắn “nhân viên” để hỏi trực tiếp.',

  attachmentOnly: () =>
    'Cảm ơn anh/chị. Em chỉ đọc được tin nhắn chữ nên đã báo nhân viên xem nội dung anh/chị gửi ạ.',

  thanks: () => 'Dạ không có gì ạ! Anh/chị cần gì thêm cứ nhắn em nhé.',

  bye: () => 'Tạm biệt anh/chị, chúc anh/chị có chuyến đi vui vẻ!',
};
