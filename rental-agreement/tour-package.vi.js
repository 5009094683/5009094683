/*
  HỢP ĐỒNG DỊCH VỤ DU LỊCH (tour trọn gói) — nội dung tiếng Việt.
  Nội dung dùng chung với các hợp đồng khác nằm trong common.vi.js.

  Trong câu chữ có thể dùng **chữ đậm**, {blank} (dòng trống để điền tay), {heart},
  và các con số lấy từ config.js như {depositPercent} {cancelFreeHours}.

  Thêm / bớt điều khoản: thêm / xoá một dòng trong danh sách "clauses".
*/
window.AGREEMENT_CONTENT = window.AGREEMENT_CONTENT || {};

window.AGREEMENT_CONTENT.vi = {
  tagline: "Tour du lịch trọn gói",
  title: "Hợp đồng dịch vụ du lịch",

  sections: {
    provider: "Bên cung cấp dịch vụ (Bên A)",
    customer: "Khách hàng (Bên B)",
    tour: "Thông tin tour",
    price: "Giá & thanh toán",
    confirm: "Xác nhận đặt tour",
    confirmWhen: "Khi đặt tour",
  },

  fields: {
    email: "Email",
    otherTravellers: "Thành viên đi cùng (họ và tên)",
    totalTravellers: "Tổng số khách",

    route: "Tour / hành trình",
    tourType: "Hình thức tour",
    tourTypes: ["Riêng", "Ghép đoàn"],
    includedItems: ["Xe đưa đón", "Hướng dẫn viên", "Lưu trú", "Ăn uống", "Vé tham quan", "Nước uống"],
    specialRequests: "Yêu cầu đặc biệt (ăn kiêng, dị ứng, sức khỏe)",
    travelInsurance: "Bảo hiểm du lịch",
    insuranceOptions: ["Tự mua", "Đã bao gồm", "Không có"],

    pricePerPerson: "Giá / khách",
  },

  // Các ô đánh dấu in phía trên phần chữ ký.
  declarations: [
    "Tôi đồng ý để Bên A sử dụng hình ảnh, video của chuyến đi cho mục đích quảng bá.",
  ],
  confirmStatement:
    "Hai bên xác nhận thông tin trên. Bên B ký thay các thành viên đi cùng và đồng ý với điều khoản ở mặt sau.",

  signature: {
    roleA: "Bên cung cấp dịch vụ",
    roleB: "Khách hàng",
  },

  articles: [
    {
      title: "Đặt tour, giá và thanh toán",
      clauses: [
        "**Đặt tour:** Việc đặt tour được xác nhận khi Bên B ký hợp đồng này và đặt cọc {depositPercent}% tổng giá trị tour. Phần còn lại được thanh toán trước khi tour khởi hành.",
        "**Giá tour:** Giá bao gồm các dịch vụ được đánh dấu tại mục 3 và nêu trong chương trình tour đã gửi cho Bên B; chương trình này là một phần của hợp đồng. Đồ uống, tiền boa và chi phí cá nhân không bao gồm trong giá.",
      ],
    },
    {
      title: "Hủy, thay đổi và bất khả kháng",
      clauses: [
        {
          text: "**Bên B hủy tour** phải báo bằng tin nhắn hoặc email. Tính đến giờ khởi hành:",
          items: [
            "Báo trước từ {cancelFreeHours} giờ trở lên: hoàn lại toàn bộ số tiền đã thanh toán, trừ phí ngân hàng.",
            "Báo trước dưới {cancelFreeHours} giờ nhưng từ {cancelLateHours} giờ trở lên: thu {cancelMidCharge}% tổng giá trị tour.",
            "Báo trước dưới {cancelLateHours} giờ, không có mặt hoặc bỏ dở tour đã khởi hành: thu 100% tổng giá trị tour.",
          ],
        },
        "**Bên B thay đổi** ngày đi, hành trình hoặc số khách tùy thuộc vào khả năng đáp ứng; chi phí phát sinh do Bên B thanh toán.",
        "**Bên A hủy tour:** Nếu Bên A không thể tổ chức tour, Bên B được chọn đổi sang ngày khác hoặc nhận lại toàn bộ số tiền đã thanh toán.",
        "**An toàn và thời tiết:** Bên A được thay đổi hành trình, thứ tự điểm tham quan, phương tiện hoặc nơi lưu trú sang dịch vụ tương đương khi thời tiết, tình trạng đường sá hoặc yêu cầu an toàn đòi hỏi.",
        "**Bất khả kháng** (bão, lũ, sạt lở, dịch bệnh, cấm đường, quyết định của cơ quan chức năng): hai bên không phải chịu trách nhiệm khi không thực hiện được hợp đồng. Bên A hoàn lại phần dịch vụ chưa sử dụng, sau khi trừ chi phí đã trả cho nhà cung cấp mà không thể thu hồi.",
      ],
    },
    {
      title: "Trách nhiệm của Bên B",
      clauses: [
        "**Giấy tờ & sức khỏe:** Bên B phải luôn mang theo hộ chiếu hoặc CCCD bản gốc (bắt buộc tại khu vực biên giới) và thông báo cho Bên A trước khi khởi hành về tình trạng sức khỏe, dị ứng hoặc nhu cầu đặc biệt.",
        "**Ứng xử:** Bên B phải tuân thủ hướng dẫn an toàn của hướng dẫn viên và tài xế, đúng giờ, tôn trọng người dân, phong tục địa phương và môi trường, chấp hành pháp luật Việt Nam. Bên A có quyền ngừng phục vụ, không hoàn tiền, đối với khách gây nguy hiểm cho người khác hoặc vi phạm pháp luật.",
        "**Tài sản & thiệt hại:** Bên B tự bảo quản tài sản cá nhân và bồi thường thiệt hại do mình gây ra đối với phương tiện, nơi lưu trú hoặc trang thiết bị.",
      ],
    },
    {
      title: "Trách nhiệm của Bên A, bảo hiểm và giới hạn trách nhiệm",
      clauses: [
        "Bên A cung cấp đúng các dịch vụ đã thỏa thuận, với hướng dẫn viên, tài xế có chuyên môn và phương tiện an toàn, hợp pháp; hỗ trợ Bên B khi ốm đau, tai nạn hoặc trường hợp khẩn cấp.",
        "**Bảo hiểm:** Bảo hiểm du lịch chỉ thuộc tour khi ô “Đã bao gồm” được đánh dấu tại mục 3. Nếu không, Bên B nên tự mua bảo hiểm chi trả chi phí y tế, tai nạn và vận chuyển cấp cứu.",
        "**Trách nhiệm:** Bên A chịu trách nhiệm về thiệt hại do lỗi của mình theo pháp luật Việt Nam. Bên A không chịu trách nhiệm về mất mát, thương tích hoặc chậm trễ do Bên B vi phạm hợp đồng, do tình trạng sức khỏe không được khai báo, do bên thứ ba ngoài tầm kiểm soát của Bên A hoặc do bất khả kháng.",
      ],
    },
    {
      title: "Điều khoản chung",
      clauses: [
        "Khách dưới 18 tuổi chỉ tham gia khi có cha mẹ hoặc người giám hộ đi cùng, hoặc có văn bản đồng ý của họ.",
        "Khiếu nại cần được báo cho hướng dẫn viên hoặc Bên A ngay trong chuyến đi, hoặc bằng văn bản trong vòng 07 ngày kể từ khi tour kết thúc.",
        "Tranh chấp được ưu tiên giải quyết qua thương lượng; nếu không thành, Tòa án nơi Bên A đặt trụ sở giải quyết theo pháp luật Việt Nam.",
        "Hợp đồng lập thành 02 bản, có giá trị ngang nhau, mỗi bên giữ 01 bản.",
      ],
    },
  ],
};
