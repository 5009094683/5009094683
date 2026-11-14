/*
  NỘI DUNG TIẾNG VIỆT

  Trong câu chữ có thể dùng:
    **chữ đậm**          in đậm
    {blank}              dòng trống để điền tay
    {heart}              hình trái tim nhỏ
    {helmetFee} {keyFee} {agreedBikeValue}   số tiền lấy từ config.js

  Thêm / bớt điều khoản: thêm / xoá một dòng trong danh sách "clauses".
*/
window.AGREEMENT_CONTENT = window.AGREEMENT_CONTENT || {};

window.AGREEMENT_CONTENT.vi = {
  languageName: "Tiếng Việt",
  fileTitle: "Hợp đồng cho thuê xe máy",
  thousandsSeparator: ".",

  tagline: "Cho thuê xe máy",
  nationalName: "Cộng hòa Xã hội Chủ nghĩa Việt Nam",
  nationalMotto: "Độc lập – Tự do – Hạnh phúc",
  title: "Hợp đồng cho thuê xe máy",
  agreementNumber: "Số:",
  addressLabel: "Địa chỉ",
  pageLabel: "Trang",

  // Lời nhắn in cạnh tên công ty ở mục 1. Để "" nếu không muốn in.
  lessorNote: "Với {heart} từ **Thu Hien**",

  sections: {
    lessor: "Bên cho thuê (Bên A)",
    renter: "Bên thuê (Bên B)",
    vehicle: "Thông tin xe và thời gian thuê",
    price: "Giá thuê & đặt cọc",
    handover: "Ký nhận bàn giao xe",
    handoverWhen: "Lúc nhận xe",
    settlement: "Thanh lý hợp đồng",
    settlementWhen: "Lúc trả xe",
  },

  fields: {
    fullName: "Họ và tên",
    birthYear: "Sinh năm",
    phone: "Điện thoại",
    address: "Địa chỉ",
    emergencyPhone: "Điện thoại liên hệ khẩn cấp",
    idNumber: "Số CCCD / Hộ chiếu",
    idIssueDate: "Cấp ngày",
    idExpiryDate: "Có giá trị đến",
    idIssuePlace: "Nơi cấp",
    licenceClass: "Giấy phép lái xe hạng",
    licenceNumber: "Số GPLX",

    model: "Loại xe",
    otherModel: "Khác:",
    plate: "Biển số",
    colour: "Màu sơn",
    condition: "Tình trạng xe",
    conditionText: "Xe hoạt động bình thường.",
    conditionNotes: "Ghi chú (vết xước, hư hỏng có sẵn):",
    accessories: "Phụ kiện kèm theo",
    accessoryItems: ["mũ bảo hiểm", "áo mưa", "giấy tờ xe (bản sao)"],
    otherAccessory: "Khác:",
    pickup: "Nhận xe (giờ · ngày)",
    return: "Trả xe (giờ · ngày)",
    totalDays: "Tổng thời gian thuê",
    days: "ngày",

    rate: "Giá thuê",
    perDay: "VNĐ / ngày",
    totalFee: "Tổng tiền thuê",
    currency: "VNĐ",
    paidBy: "Thanh toán bằng",
    cash: "Tiền mặt",
    transfer: "Chuyển khoản",
    deposit: "Tài sản thế chấp / Đặt cọc (Bên A giữ)",
  },

  handoverStatement:
    "Hai bên xác nhận Bên B đã nhận xe, giấy tờ và phụ kiện đúng tình trạng.",
  settlementStatement:
    "Bên A xác nhận đã nhận lại xe và phụ kiện. Bên B đã nhận lại tài sản thế chấp/đặt cọc và hoàn tất các chi phí.",

  signature: {
    partyA: "Bên A",
    partyB: "Bên B",
    roleA: "Bên cho thuê",
    roleB: "Bên thuê",
    hint: "Ký, ghi rõ họ tên",
  },

  termsTitle: "Các điều khoản pháp lý",
  articleLabel: "Điều",
  articles: [
    {
      title: "Nghĩa vụ và trách nhiệm Bên thuê (Bên B)",
      clauses: [
        "**Tuân thủ pháp luật:** Tự chịu trách nhiệm hoàn toàn về an toàn và rủi ro pháp lý khi tham gia giao thông.",
        "**Cam kết “Phạt nguội”:** Chịu trách nhiệm đóng phạt 100% đối với các lỗi vi phạm giao thông (kể cả phạt nguội qua camera) phát sinh trong thời gian thuê xe, kể cả khi hợp đồng đã kết thúc và Bên A nhận được thông báo sau đó.",
        "**Điều khoản cấm:** Tuyệt đối KHÔNG cầm cố, thế chấp, bán, cho thuê lại hoặc sử dụng xe để vận chuyển hàng hóa vi phạm pháp luật.",
        "**Sử dụng xe:** Tự thanh toán tiền xăng (Bên A không hoàn trả xăng thừa). Nếu muốn gia hạn thuê xe phải báo trước ít nhất 01 ngày.",
      ],
    },
    {
      title: "Rủi ro, hư hỏng và bồi thường",
      clauses: [
        {
          text: "**Hư hỏng do lỗi Bên B** (tai nạn, đâm đụng, làm rơi...):",
          items: [
            "Bên B phải chi trả 100% phí sửa chữa, thay thế bằng phụ tùng chính hãng và phí vận chuyển xe về cơ sở.",
            "Bên B phải trả tiền thuê xe cho những ngày xe phải nằm bãi sửa chữa.",
          ],
        },
        "**Mất cắp hoặc hư hỏng hoàn toàn:** Bên B bồi thường cho Bên A bằng giá trị thực tế của chiếc xe trên thị trường tại thời điểm xảy ra sự cố (hoặc theo mức giá thỏa thuận là: {agreedBikeValue} VNĐ).",
        "**Phụ kiện:** Bồi thường {helmetFee} VNĐ/01 mũ bảo hiểm mất/hỏng; bồi thường {keyFee} VNĐ nếu mất chìa khóa.",
      ],
    },
    {
      title: "Nghĩa vụ Bên cho thuê (Bên A)",
      clauses: [
        "Hỗ trợ chi phí sửa chữa, cứu hộ nếu xe hỏng hóc do hao mòn tự nhiên hoặc lỗi kỹ thuật (đứt dây phanh, hỏng động cơ...) sau khi đã kiểm tra xác minh.",
        "Hoàn trả lại tiền thuê dư nếu Bên B trả xe sớm hơn hợp đồng và hoàn trả tài sản đặt cọc khi thanh lý hợp đồng.",
        "Có quyền thu hồi xe ngay lập tức, không hoàn tiền nếu Bên B vi phạm các điều khoản cấm hoặc luật giao thông nghiêm trọng.",
      ],
    },
    {
      title: "Điều khoản chung",
      clauses: [
        "Hai bên cam kết thực hiện đúng hợp đồng. Mọi tranh chấp ưu tiên giải quyết qua thương lượng. Nếu không thành, Tòa án nơi Bên A đặt trụ sở sẽ có thẩm quyền giải quyết theo Bộ luật Dân sự hiện hành.",
        "Hợp đồng lập thành 02 bản, có giá trị ngang nhau, mỗi bên giữ 01 bản.",
      ],
    },
  ],

  toolbar: {
    print: "In / Lưu PDF",
    hint: "Khổ A4 · in 2 mặt",
    overflow: "Nội dung bị tràn khỏi trang {pages} — hãy rút gọn câu chữ.",
  },
};
