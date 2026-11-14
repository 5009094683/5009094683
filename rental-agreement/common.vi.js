/*
  NỘI DUNG TIẾNG VIỆT dùng chung cho mọi hợp đồng.

  Mỗi hợp đồng có nội dung riêng trong <hợp-đồng>.vi.js.
  Nếu cùng một dòng có ở cả hai tệp thì tệp riêng của hợp đồng được ưu tiên.

  Trong câu chữ có thể dùng:
    **chữ đậm**          in đậm
    {blank}              dòng trống để điền tay
    {heart}              hình trái tim nhỏ
    {depositPercent} {helmetFee} ...   con số lấy từ config.js
*/
window.AGREEMENT_COMMON = window.AGREEMENT_COMMON || {};

window.AGREEMENT_COMMON.vi = {
  languageName: "Tiếng Việt",
  thousandsSeparator: ".",

  nationalName: "Cộng hòa Xã hội Chủ nghĩa Việt Nam",
  nationalMotto: "Độc lập – Tự do – Hạnh phúc",
  agreementNumber: "Số:",
  addressLabel: "Địa chỉ",
  pageLabel: "Trang",

  // Lời nhắn in cạnh tên công ty ở mục 1. Để "" nếu không muốn in.
  companyNote: "Với {heart} từ **Thu Hien**",

  termsTitle: "Các điều khoản pháp lý",
  articleLabel: "Điều",

  signature: {
    partyA: "Bên A",
    partyB: "Bên B",
    hint: "Ký, ghi rõ họ tên",
  },

  // Dòng ký tên bên dưới điều khoản của hợp đồng tour và Easy Rider.
  acceptance: {
    statement: "Bên B đã đọc và đồng ý với các điều khoản trên.",
    signature: "Chữ ký:",
    date: "Ngày:",
  },

  // Các nhãn dùng ở nhiều mẫu.
  fields: {
    fullName: "Họ và tên",
    birthDate: "Ngày sinh",
    nationality: "Quốc tịch",
    idNumber: "Số CCCD / Hộ chiếu",
    phoneChat: "Điện thoại (Zalo / WhatsApp)",
    hotel: "Khách sạn / địa chỉ lưu trú",
    plate: "Biển số",
    emergencyContact: "Liên hệ khẩn cấp (tên & SĐT)",

    duration: "Số ngày / đêm",
    start: "Khởi hành (giờ · ngày)",
    end: "Kết thúc (giờ · ngày)",
    pickupDropoff: "Điểm đón & trả khách",
    included: "Dịch vụ bao gồm",
    other: "Khác:",

    totalPrice: "Tổng tiền",
    depositPaid: "Đã đặt cọc",
    balanceDue: "Còn lại",
    balanceDate: "Hạn thanh toán phần còn lại",
    currency: "VNĐ",
    paidBy: "Thanh toán bằng",
    paymentMethods: ["Tiền mặt", "Chuyển khoản"],
  },

  toolbar: {
    home: "← Tất cả hợp đồng",
    print: "In / Lưu PDF",
    hint: "Khổ A4 · in 2 mặt",
    overflow: "Nội dung bị tràn khỏi trang {pages} — hãy rút gọn câu chữ.",
  },
};
