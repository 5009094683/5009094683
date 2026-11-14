/*
  HỢP ĐỒNG DỊCH VỤ EASY RIDER — nội dung tiếng Việt.
  (Khách ngồi sau xe máy do tài xế của công ty điều khiển.)
  Nội dung dùng chung với các hợp đồng khác nằm trong common.vi.js.

  Trong câu chữ có thể dùng **chữ đậm**, {blank} (dòng trống để điền tay), {heart},
  và các con số lấy từ config.js như {depositPercent} {luggageLimitKg} {helmetFee}.

  Thêm / bớt điều khoản: thêm / xoá một dòng trong danh sách "clauses".
*/
window.AGREEMENT_CONTENT = window.AGREEMENT_CONTENT || {};

window.AGREEMENT_CONTENT.vi = {
  tagline: "Tour xe máy có tài xế",
  title: "Hợp đồng dịch vụ Easy Rider",

  sections: {
    provider: "Bên cung cấp dịch vụ (Bên A)",
    passenger: "Hành khách (Bên B)",
    trip: "Thông tin chuyến đi",
    price: "Giá & thanh toán",
    confirm: "Kiểm tra an toàn & ký nhận",
    confirmWhen: "Trước khi khởi hành",
  },

  fields: {
    health: "Tình trạng sức khỏe, dị ứng, thuốc đang dùng",

    route: "Hành trình",
    driver: "Tài xế",
    driverPhone: "Điện thoại tài xế",
    includedItems: [
      "Tài xế kiêm hướng dẫn",
      "Xe máy & xăng",
      "Mũ bảo hiểm",
      "Áo mưa",
      "Bảo hộ gối & khuỷu tay",
      "Lưu trú",
      "Ăn uống",
      "Vé tham quan",
    ],

    pricePerDay: "Giá / ngày",
  },

  // Các ô đánh dấu in phía trên phần chữ ký.
  declarations: [
    "Tôi đã nhận mũ bảo hiểm vừa vặn và được tài xế hướng dẫn an toàn.",
    "Tôi đủ sức khỏe để ngồi sau xe máy và đã khai báo tình trạng sức khỏe tại mục 2.",
    "Tôi có bảo hiểm du lịch chi trả khi đi xe máy.",
    "Tôi không có bảo hiểm và tự chịu rủi ro.",
    "Tôi đồng ý để Bên A sử dụng hình ảnh, video của chuyến đi cho mục đích quảng bá.",
  ],
  confirmStatement:
    "Hai bên xác nhận thông tin trên. Bên B đã đọc và đồng ý với các điều khoản ở mặt sau.",

  signature: {
    roleA: "Bên cung cấp dịch vụ",
    roleB: "Hành khách",
  },

  articles: [
    {
      title: "Dịch vụ và trách nhiệm của Bên A",
      clauses: [
        "Bên A cung cấp xe máy và tài xế kiêm hướng dẫn để chở Bên B theo hành trình tại mục 3. Bên B không tự điều khiển xe máy.",
        "**Tài xế & xe máy:** Tài xế có giấy phép lái xe hợp lệ và không lái xe sau khi uống rượu bia. Xe máy bảo đảm an toàn kỹ thuật, có đăng ký và bảo hiểm theo quy định của pháp luật Việt Nam. Bên A cung cấp mũ bảo hiểm đạt chuẩn.",
        "**An toàn là trên hết:** Tài xế được thay đổi hành trình, thời gian hoặc dừng chuyến đi khi thời tiết, tình trạng đường sá hoặc yêu cầu an toàn đòi hỏi. Khi xe hỏng, có tai nạn hoặc ốm đau, Bên A nhanh chóng hỗ trợ, sửa chữa hoặc thay thế.",
      ],
    },
    {
      title: "Trách nhiệm của Bên B và quy tắc an toàn",
      clauses: [
        "**Trên xe:** Bên B phải luôn cài quai mũ bảo hiểm, tuân theo hướng dẫn của tài xế, bám chắc và không làm tài xế mất tập trung. Nên mặc quần dài và đi giày kín mũi.",
        "**Rượu bia & chất kích thích:** Tài xế có quyền từ chối chở khách đang say rượu bia, sử dụng chất kích thích hoặc không tuân thủ quy tắc an toàn; Bên B không được hoàn tiền.",
        "**Sức khỏe:** Bên B xác nhận đủ sức khỏe để ngồi sau xe máy trên đường đèo núi. Không khuyến khích phụ nữ mang thai hoặc người có bệnh nặng về tim mạch, cột sống hoặc cổ tham gia.",
        "**Hành lý, giấy tờ & thiệt hại:** Hành lý mang theo xe tối đa {luggageLimitKg} kg. Bên B phải mang theo hộ chiếu hoặc CCCD bản gốc (bắt buộc tại khu vực biên giới), tự bảo quản tài sản có giá trị và bồi thường thiệt hại do mình gây ra cho xe hoặc trang thiết bị, kể cả {helmetFee} VNĐ nếu làm mất hoặc hỏng mũ bảo hiểm.",
      ],
    },
    {
      title: "Thanh toán, hủy và thay đổi",
      clauses: [
        "**Đặt dịch vụ & thanh toán:** Việc đặt dịch vụ được xác nhận khi Bên B đặt cọc {depositPercent}% tổng giá trị; phần còn lại thanh toán trước khi khởi hành. Giá bao gồm các dịch vụ được đánh dấu tại mục 3; đồ uống, tiền boa và chi phí cá nhân không bao gồm.",
        {
          text: "**Bên B hủy dịch vụ** phải báo bằng tin nhắn hoặc email. Tính đến giờ khởi hành:",
          items: [
            "Báo trước từ {cancelFreeHours} giờ trở lên: hoàn lại toàn bộ số tiền đã thanh toán, trừ phí ngân hàng.",
            "Báo trước dưới {cancelFreeHours} giờ nhưng từ {cancelLateHours} giờ trở lên: thu {cancelMidCharge}% tổng giá trị.",
            "Báo trước dưới {cancelLateHours} giờ, không có mặt hoặc bỏ dở chuyến đi đã khởi hành: thu 100% tổng giá trị.",
          ],
        },
        "**Bên A hủy & bất khả kháng:** Nếu Bên A không thể thực hiện hoặc hoàn thành chuyến đi, Bên B được chọn đổi ngày hoặc nhận lại tiền của các ngày chưa sử dụng. Khi xảy ra bất khả kháng (bão, lũ, sạt lở, cấm đường, quyết định của cơ quan chức năng), khoản hoàn lại được trừ chi phí đã trả cho nhà cung cấp mà không thể thu hồi.",
      ],
    },
    {
      title: "Rủi ro, bảo hiểm và trách nhiệm",
      clauses: [
        "**Rủi ro:** Di chuyển bằng xe máy trên đường đèo núi tiềm ẩn những rủi ro không thể loại bỏ hoàn toàn, bao gồm tai nạn và thương tích. Bên B tự nguyện tham gia và chấp nhận các rủi ro này.",
        "**Bảo hiểm:** Bên B nên có bảo hiểm du lịch chi trả cho người ngồi sau xe máy, chi phí y tế và vận chuyển cấp cứu.",
        "**Trách nhiệm:** Bên A chịu trách nhiệm về thiệt hại do lỗi của tài xế theo pháp luật Việt Nam. Bên A không chịu trách nhiệm về mất mát, thương tích do Bên B vi phạm quy tắc an toàn, do sức khỏe không được khai báo, do bên thứ ba hoặc do bất khả kháng.",
      ],
    },
    {
      title: "Điều khoản chung",
      clauses: [
        "Khách dưới 18 tuổi chỉ tham gia khi có văn bản đồng ý của cha mẹ hoặc người giám hộ.",
        "Khiếu nại cần được báo cho tài xế hoặc Bên A ngay trong chuyến đi, hoặc bằng văn bản trong vòng 07 ngày kể từ khi chuyến đi kết thúc.",
        "Tranh chấp được ưu tiên giải quyết qua thương lượng; nếu không thành, Tòa án nơi Bên A đặt trụ sở giải quyết theo pháp luật Việt Nam.",
        "Hợp đồng lập thành 02 bản, có giá trị ngang nhau, mỗi bên giữ 01 bản.",
      ],
    },
  ],
};
