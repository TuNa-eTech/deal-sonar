//! Vietnamese administrative unit data used to build the gazetteer index.

use super::*;

pub(super) fn p_only(
    province: &'static str,
    aliases: &'static [&'static str],
    short_aliases: &'static [&'static str],
) -> AdminEntry {
    AdminEntry {
        province,
        district: None,
        ward: None,
        aliases,
        short_aliases,
    }
}

pub(super) fn dist(
    province: &'static str,
    district: &'static str,
    aliases: &'static [&'static str],
    short_aliases: &'static [&'static str],
) -> AdminEntry {
    AdminEntry {
        province,
        district: Some(district),
        ward: None,
        aliases,
        short_aliases,
    }
}

pub(super) fn ward(
    province: &'static str,
    district: &'static str,
    ward_name: &'static str,
    aliases: &'static [&'static str],
) -> AdminEntry {
    AdminEntry {
        province,
        district: Some(district),
        ward: Some(ward_name),
        aliases,
        short_aliases: &[],
    }
}

pub(super) fn build_vn_admin_index() -> GazetteerIndex {
    let entries = vec![
        // ======================== 63 PROVINCES & MUNICIPALITIES ========================
        p_only(
            "Hà Nội",
            &[
                "ha noi",
                "tp ha noi",
                "thanh pho ha noi",
                "hanoi",
                "thu do ha noi",
                "hn",
            ],
            &[],
        ),
        p_only(
            "TP. Hồ Chí Minh",
            &[
                "tp ho chi minh",
                "ho chi minh",
                "tp.hcm",
                "tp hcm",
                "tphcm",
                "hcm",
                "sai gon",
                "saigon",
                "sg",
            ],
            &[],
        ),
        p_only("Đà Nẵng", &["da nang", "tp da nang", "danang"], &["dn"]),
        p_only(
            "Hải Phòng",
            &["hai phong", "tp hai phong", "haiphong"],
            &["hp"],
        ),
        p_only("Cần Thơ", &["can tho", "tp can tho", "cantho"], &[]),
        p_only("Huế", &["thua thien hue", "tp hue", "hue"], &[]),
        p_only("Bình Dương", &["binh duong", "tinh binh duong"], &["bd"]),
        p_only("Đồng Nai", &["dong nai", "tinh dong nai"], &[]),
        p_only(
            "Bà Rịa - Vũng Tàu",
            &["ba ria - vung tau", "ba ria vung tau", "brvt", "br-vt"],
            &[],
        ),
        p_only("Khánh Hoà", &["khanh hoa", "tinh khanh hoa"], &[]),
        p_only("Bắc Ninh", &["bac ninh", "tinh bac ninh"], &[]),
        p_only("Hưng Yên", &["hung yen", "tinh hung yen"], &[]),
        p_only("Quảng Ninh", &["quang ninh", "tinh quang ninh"], &[]),
        p_only(
            "Vĩnh Phúc",
            &["vinh phuc", "tinh vinh phuc", "vinh yen"],
            &[],
        ),
        p_only("Bắc Giang", &["bac giang", "tp bac giang"], &[]),
        p_only("Hải Dương", &["hai duong", "tp hai duong"], &[]),
        p_only("Thái Bình", &["thai binh", "tp thai binh"], &[]),
        p_only("Nam Định", &["nam dinh", "tp nam dinh"], &[]),
        p_only("Ninh Bình", &["ninh binh", "tp ninh binh", "hoa lu"], &[]),
        p_only("Hà Nam", &["ha nam", "phu ly"], &[]),
        p_only(
            "Thái Nguyên",
            &["thai nguyen", "tp thai nguyen", "pho yen"],
            &[],
        ),
        p_only("Phú Thọ", &["phu tho", "viet tri"], &[]),
        p_only("Tuyên Quang", &["tuyen quang", "tp tuyen quang"], &[]),
        p_only("Lào Cai", &["lao cai", "tp lao cai", "sa pa", "sapa"], &[]),
        p_only("Yên Bái", &["yen bai", "tp yen bai"], &[]),
        p_only("Hà Giang", &["ha giang", "tp ha giang"], &[]),
        p_only("Cao Bằng", &["cao bang", "tp cao bang"], &[]),
        p_only("Bắc Kạn", &["bac kan", "bac can"], &[]),
        p_only("Lạng Sơn", &["lang son", "tp lang son"], &[]),
        p_only("Điện Biên", &["dien bien", "dien bien phu"], &[]),
        p_only("Lai Châu", &["lai chau", "tp lai chau"], &[]),
        p_only("Sơn La", &["son la", "tp son la", "moc chau"], &[]),
        p_only("Hoà Bình", &["hoa binh", "tp hoa binh", "luong son"], &[]),
        p_only("Thanh Hoá", &["thanh hoa", "tp thanh hoa", "sam son"], &[]),
        p_only("Nghệ An", &["nghe an", "tp vinh", "cua lo"], &[]),
        p_only("Hà Tĩnh", &["ha tinh", "tp ha tinh", "ky anh"], &[]),
        p_only("Quảng Bình", &["quang binh", "dong hoi"], &[]),
        p_only("Quảng Trị", &["quang tri", "dong ha"], &[]),
        p_only("Quảng Nam", &["quang nam", "tam ky", "hoi an"], &[]),
        p_only("Quảng Ngãi", &["quang ngai", "tp quang ngai"], &[]),
        p_only("Bình Định", &["binh dinh", "quy nhon"], &[]),
        p_only("Phú Yên", &["phu yen", "tuy hoa"], &[]),
        p_only("Ninh Thuận", &["ninh thuan", "phan rang"], &[]),
        p_only("Bình Thuận", &["binh thuan", "phan thiet", "mui ne"], &[]),
        p_only("Kon Tum", &["kon tum", "tp kon tum"], &[]),
        p_only("Gia Lai", &["gia lai", "pleiku"], &[]),
        p_only(
            "Đắk Lắk",
            &["dak lak", "dac lac", "buon ma thuot", "bmt"],
            &[],
        ),
        p_only("Đắk Nông", &["dak nong", "dac nong", "gia nghia"], &[]),
        p_only("Lâm Đồng", &["lam dong", "da lat", "dalat", "bao loc"], &[]),
        p_only("Bình Phước", &["binh phuoc", "dong xoai"], &[]),
        p_only("Tây Ninh", &["tay ninh", "tp tay ninh"], &[]),
        p_only(
            "Long An",
            &["long an", "tan an", "duc hoa", "ben luc", "can giuoc"],
            &[],
        ),
        p_only("Tiền Giang", &["tien giang", "my tho"], &[]),
        p_only("Bến Tre", &["ben tre", "tp ben tre"], &[]),
        p_only("Trà Vinh", &["tra vinh", "tp tra vinh"], &[]),
        p_only("Vĩnh Long", &["vinh long", "tp vinh long"], &[]),
        p_only("Đồng Tháp", &["dong thap", "cao lanh", "sa dec"], &[]),
        p_only("An Giang", &["an giang", "long xuyen", "chau doc"], &[]),
        p_only(
            "Kiên Giang",
            &["kien giang", "rach gia", "phu quoc", "ha tien"],
            &[],
        ),
        p_only("Hậu Giang", &["hau giang", "vi thanh"], &[]),
        p_only("Sóc Trăng", &["soc trang", "tp soc trang"], &[]),
        p_only("Bạc Liêu", &["bac lieu", "tp bac lieu"], &[]),
        p_only("Cà Mau", &["ca mau", "tp ca mau"], &[]),
        // ======================== HÀ NỘI — ALL 30 DISTRICTS ========================
        dist(
            "Hà Nội",
            "Cầu Giấy",
            &["cau giay", "quan cau giay", "q.cau giay", "q cau giay"],
            &["cg"],
        ),
        dist(
            "Hà Nội",
            "Nam Từ Liêm",
            &["nam tu liem", "quan nam tu liem", "ntl"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Bắc Từ Liêm",
            &["bac tu liem", "quan bac tu liem", "btl"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Thanh Xuân",
            &["thanh xuan", "quan thanh xuan", "q.thanh xuan"],
            &["tx"],
        ),
        dist(
            "Hà Nội",
            "Đống Đa",
            &["dong da", "quan dong da", "q.dong da"],
            &["dd"],
        ),
        dist(
            "Hà Nội",
            "Ba Đình",
            &["ba dinh", "quan ba dinh", "q.ba dinh"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Hoàn Kiếm",
            &["hoan kiem", "quan hoan kiem", "pho co"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Tây Hồ",
            &["tay ho", "quan tay ho", "ho tay"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Hai Bà Trưng",
            &["hai ba trung", "quan hai ba trung", "hbt"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Hoàng Mai",
            &["hoang mai", "quan hoang mai"],
            &["hm"],
        ),
        dist(
            "Hà Nội",
            "Long Biên",
            &["long bien", "quan long bien"],
            &["lb"],
        ),
        dist("Hà Nội", "Hà Đông", &["ha dong", "quan ha dong"], &[]),
        dist("Hà Nội", "Gia Lâm", &["gia lam", "huyen gia lam"], &[]),
        dist("Hà Nội", "Đông Anh", &["dong anh", "huyen dong anh"], &[]),
        dist(
            "Hà Nội",
            "Thanh Trì",
            &["thanh tri", "huyen thanh tri"],
            &[],
        ),
        dist("Hà Nội", "Hoài Đức", &["hoai duc", "huyen hoai duc"], &[]),
        dist(
            "Hà Nội",
            "Đan Phượng",
            &["dan phuong", "huyen dan phuong"],
            &[],
        ),
        dist("Hà Nội", "Sóc Sơn", &["soc son", "huyen soc son"], &[]),
        dist("Hà Nội", "Mê Linh", &["me linh", "huyen me linh"], &[]),
        dist(
            "Hà Nội",
            "Thạch Thất",
            &["thach that", "huyen thach that", "hoa lac"],
            &[],
        ),
        dist("Hà Nội", "Quốc Oai", &["quoc oai", "huyen quoc oai"], &[]),
        dist(
            "Hà Nội",
            "Chương Mỹ",
            &["chuong my", "huyen chuong my"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Thanh Oai",
            &["thanh oai", "huyen thanh oai"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Thường Tín",
            &["thuong tin", "huyen thuong tin"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Phú Xuyên",
            &["phu xuyen", "huyen phu xuyen"],
            &[],
        ),
        dist("Hà Nội", "Ứng Hoà", &["ung hoa", "huyen ung hoa"], &[]),
        dist("Hà Nội", "Mỹ Đức", &["my duc", "huyen my duc"], &[]),
        dist("Hà Nội", "Ba Vì", &["ba vi", "huyen ba vi"], &[]),
        dist("Hà Nội", "Phúc Thọ", &["phuc tho", "huyen phuc tho"], &[]),
        dist(
            "Hà Nội",
            "Sơn Tây",
            &["son tay", "thi xa son tay", "tx son tay"],
            &[],
        ),
        // Hà Nội — Major Wards & Urban Areas
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Dịch Vọng",
            &["dich vong", "phuong dich vong"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Dịch Vọng Hậu",
            &["dich vong hau", "duy tan", "tran thai tong", "xuan thuy"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Mai Dịch",
            &["mai dich", "phuong mai dich", "ho tung mau"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Nghĩa Đô",
            &["nghia do", "hoang quoc viet"],
        ),
        ward("Hà Nội", "Cầu Giấy", "Nghĩa Tân", &["nghia tan", "to hieu"]),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Quan Hoa",
            &["quan hoa", "nguyen khanh toan"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Trung Hoà",
            &["trung hoa", "trung hoa nhan chinh", "tran duy hung"],
        ),
        ward("Hà Nội", "Cầu Giấy", "Yên Hoà", &["yen hoa", "trung kinh"]),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Mỹ Đình 1",
            &["my dinh", "my dinh 1"],
        ),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Mỹ Đình 2",
            &["my dinh 2", "le duc tho", "ham nghi"],
        ),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Mễ Trì",
            &["me tri", "keangnam", "the manor"],
        ),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Tây Mỗ",
            &["tay mo", "vinhomes smart city", "smart city"],
        ),
        ward("Hà Nội", "Nam Từ Liêm", "Đại Mỗ", &["dai mo"]),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Trung Văn",
            &["trung van", "to huu"],
        ),
        ward("Hà Nội", "Nam Từ Liêm", "Phú Đô", &["phu do"]),
        ward("Hà Nội", "Nam Từ Liêm", "Cầu Diễn", &["cau dien"]),
        ward("Hà Nội", "Nam Từ Liêm", "Xuân Phương", &["xuan phuong"]),
        ward("Hà Nội", "Nam Từ Liêm", "Phương Canh", &["phuong canh"]),
        ward(
            "Hà Nội",
            "Bắc Từ Liêm",
            "Cổ Nhuế 1",
            &["co nhue", "co nhue 1", "co nhue 2", "thanh pho giao luu"],
        ),
        ward(
            "Hà Nội",
            "Bắc Từ Liêm",
            "Xuân Đỉnh",
            &["xuan dinh", "ngoai giao doan"],
        ),
        ward("Hà Nội", "Bắc Từ Liêm", "Xuân Tảo", &["xuan tao"]),
        ward("Hà Nội", "Bắc Từ Liêm", "Phú Diễn", &["phu dien"]),
        ward("Hà Nội", "Bắc Từ Liêm", "Đông Ngạc", &["dong ngac"]),
        ward(
            "Hà Nội",
            "Thanh Xuân",
            "Nhân Chính",
            &["nhan chinh", "le van luong"],
        ),
        ward(
            "Hà Nội",
            "Thanh Xuân",
            "Thượng Đình",
            &["thuong dinh", "royal city", "nga tu so"],
        ),
        ward("Hà Nội", "Thanh Xuân", "Khương Trung", &["khuong trung"]),
        ward("Hà Nội", "Thanh Xuân", "Khương Đình", &["khuong dinh"]),
        ward("Hà Nội", "Thanh Xuân", "Khương Mai", &["khuong mai"]),
        ward("Hà Nội", "Thanh Xuân", "Hạ Đình", &["ha dinh"]),
        ward("Hà Nội", "Thanh Xuân", "Kim Giang", &["kim giang"]),
        ward("Hà Nội", "Thanh Xuân", "Phương Liệt", &["phuong liet"]),
        ward(
            "Hà Nội",
            "Thanh Xuân",
            "Thanh Xuân Trung",
            &["thanh xuan trung", "nguyen tuan", "vu trong phung"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Láng Hạ",
            &["lang ha", "huynh thuc khang"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Láng Thượng",
            &["lang thuong", "chua lang", "duong lang"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Ô Chợ Dừa",
            &["o cho dua", "hoang cau"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Trung Liệt",
            &["trung liet", "thai ha", "chua boc", "tay son"],
        ),
        ward("Hà Nội", "Đống Đa", "Phương Mai", &["phuong mai"]),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Kim Liên",
            &["kim lien", "pham ngoc thach"],
        ),
        ward("Hà Nội", "Đống Đa", "Khâm Thiên", &["kham thien"]),
        ward("Hà Nội", "Đống Đa", "Cát Linh", &["cat linh"]),
        ward("Hà Nội", "Ba Đình", "Giảng Võ", &["giang vo"]),
        ward("Hà Nội", "Ba Đình", "Kim Mã", &["kim ma"]),
        ward(
            "Hà Nội",
            "Ba Đình",
            "Liễu Giai",
            &["lieu giai", "dao tan", "van cao"],
        ),
        ward("Hà Nội", "Ba Đình", "Đội Cấn", &["doi can"]),
        ward("Hà Nội", "Ba Đình", "Ngọc Khánh", &["ngoc khanh"]),
        ward("Hà Nội", "Ba Đình", "Thành Công", &["thanh cong"]),
        ward("Hà Nội", "Tây Hồ", "Xuân La", &["xuan la", "vo chi cong"]),
        ward("Hà Nội", "Tây Hồ", "Phú Thượng", &["phu thuong", "ciputra"]),
        ward(
            "Hà Nội",
            "Tây Hồ",
            "Quảng An",
            &["quang an", "to ngoc van", "xuan dieu"],
        ),
        ward("Hà Nội", "Tây Hồ", "Thuỵ Khuê", &["thuy khue"]),
        ward("Hà Nội", "Tây Hồ", "Bưởi", &["phuong buoi", "trich sai"]),
        ward(
            "Hà Nội",
            "Hai Bà Trưng",
            "Vĩnh Tuy",
            &["vinh tuy", "times city"],
        ),
        ward("Hà Nội", "Hai Bà Trưng", "Minh Khai", &["minh khai"]),
        ward(
            "Hà Nội",
            "Hai Bà Trưng",
            "Bách Khoa",
            &["bach khoa", "ta quang buu"],
        ),
        ward("Hà Nội", "Hai Bà Trưng", "Bạch Mai", &["bach mai"]),
        ward("Hà Nội", "Hai Bà Trưng", "Trương Định", &["truong dinh"]),
        ward(
            "Hà Nội",
            "Hoàng Mai",
            "Hoàng Liệt",
            &["hoang liet", "linh dam"],
        ),
        ward("Hà Nội", "Hoàng Mai", "Định Công", &["dinh cong"]),
        ward(
            "Hà Nội",
            "Hoàng Mai",
            "Đại Kim",
            &["dai kim", "kim van kim lu"],
        ),
        ward("Hà Nội", "Hoàng Mai", "Tân Mai", &["tan mai"]),
        ward("Hà Nội", "Hoàng Mai", "Yên Sở", &["yen so", "gamuda"]),
        ward("Hà Nội", "Long Biên", "Bồ Đề", &["bo de"]),
        ward("Hà Nội", "Long Biên", "Ngọc Thuỵ", &["ngoc thuy"]),
        ward(
            "Hà Nội",
            "Long Biên",
            "Việt Hưng",
            &["viet hung", "vinhomes riverside"],
        ),
        ward("Hà Nội", "Long Biên", "Sài Đồng", &["sai dong"]),
        ward("Hà Nội", "Long Biên", "Thạch Bàn", &["thach ban"]),
        ward("Hà Nội", "Hà Đông", "Mộ Lao", &["mo lao", "lang viet kieu"]),
        ward("Hà Nội", "Hà Đông", "Văn Quán", &["van quan"]),
        ward("Hà Nội", "Hà Đông", "Dương Nội", &["duong noi"]),
        ward("Hà Nội", "Hà Đông", "La Khê", &["la khe", "van khe"]),
        ward("Hà Nội", "Hà Đông", "Phúc La", &["phuc la", "xa la"]),
        ward("Hà Nội", "Hà Đông", "Vạn Phúc", &["van phuc"]),
        ward(
            "Hà Nội",
            "Gia Lâm",
            "Đa Tốn",
            &["da ton", "vinhomes ocean park", "ocean park"],
        ),
        ward("Hà Nội", "Gia Lâm", "Trâu Quỳ", &["trau quy"]),
        // ======================== TP. HỒ CHÍ MINH — ALL DISTRICTS ========================
        dist(
            "TP. Hồ Chí Minh",
            "Quận 1",
            &["quan 1", "q.1", "q 1", "q1"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 2",
            &["quan 2", "q.2", "q 2", "q2"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 3",
            &["quan 3", "q.3", "q 3", "q3"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 4",
            &["quan 4", "q.4", "q 4", "q4"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 5",
            &["quan 5", "q.5", "q 5", "q5"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 6",
            &["quan 6", "q.6", "q 6", "q6"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 7",
            &["quan 7", "q.7", "q 7", "q7"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 8",
            &["quan 8", "q.8", "q 8", "q8"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 9",
            &["quan 9", "q.9", "q 9", "q9"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 10",
            &["quan 10", "q.10", "q 10", "q10"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 11",
            &["quan 11", "q.11", "q 11", "q11"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 12",
            &["quan 12", "q.12", "q 12", "q12"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            &[
                "tp thu duc",
                "thanh pho thu duc",
                "thu duc",
                "q.thu duc",
                "tptd",
            ],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Bình Thạnh",
            &[
                "binh thanh",
                "quan binh thanh",
                "q.binh thanh",
                "q.bt",
                "qbt",
            ],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Gò Vấp",
            &["go vap", "quan go vap", "q.go vap", "q.gv", "qgv"],
            &["gv"],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Phú Nhuận",
            &["phu nhuan", "quan phu nhuan", "q.phu nhuan", "q.pn", "qpn"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Tân Bình",
            &["tan binh", "quan tan binh", "q.tan binh", "q.tb", "qtb"],
            &["tb"],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Tân Phú",
            &["tan phu", "quan tan phu", "q.tan phu", "q.tp"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Bình Tân",
            &["binh tan", "quan binh tan", "q.binh tan", "btan"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Bình Chánh",
            &["binh chanh", "huyen binh chanh"],
            &["bc"],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Nhà Bè",
            &["nha be", "huyen nha be"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Hóc Môn",
            &["hoc mon", "huyen hoc mon"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Củ Chi",
            &["cu chi", "huyen cu chi"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Cần Giờ",
            &["can gio", "huyen can gio"],
            &[],
        ),
        // TP.HCM — Major Wards & Urban Areas
        ward("TP. Hồ Chí Minh", "Quận 1", "Bến Nghé", &["ben nghe"]),
        ward("TP. Hồ Chí Minh", "Quận 1", "Bến Thành", &["ben thanh"]),
        ward("TP. Hồ Chí Minh", "Quận 1", "Đa Kao", &["da kao", "dakao"]),
        ward("TP. Hồ Chí Minh", "Quận 1", "Tân Định", &["tan dinh"]),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Thảo Điền",
            &["thao dien", "phuong thao dien"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "An Phú",
            &["an phu", "an khanh"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Thủ Thiêm",
            &["thu thiem", "sala"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Thạnh Mỹ Lợi",
            &["thanh my loi"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Hiệp Bình Chánh",
            &["hiep binh chanh", "pham van dong"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Linh Trung",
            &["linh trung", "linh chieu", "linh dong", "linh tay"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Long Thạnh Mỹ",
            &["long thanh my", "vinhomes grand park"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Quận 7",
            "Tân Phong",
            &["tan phong", "phu my hung"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Quận 7",
            "Tân Hưng",
            &["tan hung", "sunrise city"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Quận 7",
            "Tân Thuận Đông",
            &["tan thuan", "tan quy"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Bình Thạnh",
            "Phường 22",
            &["vinhomes central park", "landmark 81", "tan cang"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Bình Thạnh",
            "Phường 19",
            &["pham viet chanh", "hang xanh"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Bình Chánh",
            "Bình Hưng",
            &["trung son", "kdc trung son"],
        ),
        // ======================== ĐÀ NẴNG ========================
        dist("Đà Nẵng", "Hải Châu", &["hai chau", "quan hai chau"], &[]),
        dist(
            "Đà Nẵng",
            "Sơn Trà",
            &["son tra", "quan son tra", "phuoc my", "an thuong"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Ngũ Hành Sơn",
            &["ngu hanh son", "quan ngu hanh son", "my an"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Thanh Khê",
            &["thanh khe", "quan thanh khe"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Liên Chiểu",
            &["lien chieu", "quan lien chieu", "hoa khanh"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Cẩm Lệ",
            &["cam le", "quan cam le", "hoa xuan"],
            &[],
        ),
        dist("Đà Nẵng", "Hoà Vang", &["hoa vang", "huyen hoa vang"], &[]),
        // ======================== HẢI PHÒNG ========================
        dist(
            "Hải Phòng",
            "Ngô Quyền",
            &["ngo quyen", "quan ngo quyen", "van cao hai phong"],
            &[],
        ),
        dist("Hải Phòng", "Lê Chân", &["le chan", "quan le chan"], &[]),
        dist(
            "Hải Phòng",
            "Hồng Bàng",
            &["hong bang", "quan hong bang"],
            &[],
        ),
        dist("Hải Phòng", "Hải An", &["hai an", "quan hai an"], &[]),
        dist("Hải Phòng", "Kiến An", &["kien an", "quan kien an"], &[]),
        dist("Hải Phòng", "Đồ Sơn", &["do son", "quan do son"], &[]),
        dist(
            "Hải Phòng",
            "Dương Kinh",
            &["duong kinh", "quan duong kinh"],
            &[],
        ),
        dist(
            "Hải Phòng",
            "Thuỷ Nguyên",
            &["thuy nguyen", "tp thuy nguyen"],
            &[],
        ),
        dist("Hải Phòng", "An Dương", &["an duong", "quan an duong"], &[]),
        dist("Hải Phòng", "Cát Hải", &["cat hai", "cat ba"], &[]),
        // ======================== CẦN THƠ ========================
        dist(
            "Cần Thơ",
            "Ninh Kiều",
            &["ninh kieu", "quan ninh kieu"],
            &[],
        ),
        dist("Cần Thơ", "Cái Răng", &["cai rang", "quan cai rang"], &[]),
        dist(
            "Cần Thơ",
            "Bình Thuỷ",
            &["binh thuy", "quan binh thuy"],
            &[],
        ),
        dist("Cần Thơ", "Ô Môn", &["o mon", "quan o mon"], &[]),
        dist("Cần Thơ", "Thốt Nốt", &["thot not", "quan thot not"], &[]),
        // ======================== BÌNH DƯƠNG, ĐỒNG NAI, BR-VT, KHÁNH HOÀ, BẮC NINH, HƯNG YÊN, QUẢNG NINH ========================
        dist(
            "Bình Dương",
            "Thủ Dầu Một",
            &["thu dau mot", "tp thu dau mot", "tdm"],
            &[],
        ),
        dist(
            "Bình Dương",
            "Dĩ An",
            &["di an", "tp di an", "dong hoa"],
            &[],
        ),
        dist(
            "Bình Dương",
            "Thuận An",
            &["thuan an", "tp thuan an", "lai thieu"],
            &[],
        ),
        dist("Bình Dương", "Bến Cát", &["ben cat", "tp ben cat"], &[]),
        dist("Bình Dương", "Tân Uyên", &["tan uyen", "tp tan uyen"], &[]),
        dist("Đồng Nai", "Biên Hoà", &["bien hoa", "tp bien hoa"], &[]),
        dist(
            "Đồng Nai",
            "Long Thành",
            &["long thanh", "huyen long thanh"],
            &[],
        ),
        dist(
            "Đồng Nai",
            "Nhơn Trạch",
            &["nhon trach", "huyen nhon trach"],
            &[],
        ),
        dist(
            "Đồng Nai",
            "Long Khánh",
            &["long khanh", "tp long khanh"],
            &[],
        ),
        dist(
            "Đồng Nai",
            "Trảng Bom",
            &["trang bom", "huyen trang bom"],
            &[],
        ),
        dist(
            "Bà Rịa - Vũng Tàu",
            "Vũng Tàu",
            &["vung tau", "tp vung tau"],
            &[],
        ),
        dist("Bà Rịa - Vũng Tàu", "Bà Rịa", &["tp ba ria"], &[]),
        dist("Bà Rịa - Vũng Tàu", "Phú Mỹ", &["phu my", "tx phu my"], &[]),
        dist(
            "Bà Rịa - Vũng Tàu",
            "Xuyên Mộc",
            &["xuyen moc", "ho tram"],
            &[],
        ),
        dist(
            "Khánh Hoà",
            "Nha Trang",
            &["nha trang", "tp nha trang", "vinh diem trung"],
            &[],
        ),
        dist("Khánh Hoà", "Cam Ranh", &["cam ranh", "tp cam ranh"], &[]),
        dist("Khánh Hoà", "Cam Lâm", &["cam lam", "bai dai"], &[]),
        dist("Khánh Hoà", "Ninh Hoà", &["ninh hoa", "tx ninh hoa"], &[]),
        dist("Bắc Ninh", "TP Bắc Ninh", &["tp bac ninh"], &[]),
        dist("Bắc Ninh", "Từ Sơn", &["tu son", "tp tu son"], &[]),
        dist(
            "Bắc Ninh",
            "Yên Phong",
            &["yen phong", "kcn yen phong"],
            &[],
        ),
        dist("Bắc Ninh", "Quế Võ", &["que vo", "tx que vo"], &[]),
        dist("Bắc Ninh", "Tiên Du", &["tien du"], &[]),
        dist(
            "Bắc Ninh",
            "Thuận Thành",
            &["thuan thanh", "tx thuan thanh"],
            &[],
        ),
        dist(
            "Hưng Yên",
            "Văn Giang",
            &["van giang", "ecopark", "ocean park 2", "ocean park 3"],
            &[],
        ),
        dist("Hưng Yên", "Mỹ Hào", &["my hao", "tx my hao"], &[]),
        dist("Hưng Yên", "Văn Lâm", &["van lam"], &[]),
        dist(
            "Quảng Ninh",
            "Hạ Long",
            &["ha long", "tp ha long", "halong", "bai chay", "hon gai"],
            &[],
        ),
        dist("Quảng Ninh", "Cẩm Phả", &["cam pha", "tp cam pha"], &[]),
        dist("Quảng Ninh", "Uông Bí", &["uong bi", "tp uong bi"], &[]),
        dist("Quảng Ninh", "Móng Cái", &["mong cai", "tp mong cai"], &[]),
        dist(
            "Quảng Ninh",
            "Quảng Yên",
            &["quang yen", "tx quang yen"],
            &[],
        ),
        dist(
            "Quảng Ninh",
            "Đông Triều",
            &["dong trieu", "tp dong trieu"],
            &[],
        ),
    ];

    let mut raw_by_first_word: HashMap<&'static str, Vec<(&'static str, CompiledAlias)>> =
        HashMap::new();
    let mut province_scope_map: HashMap<&'static str, &'static str> = HashMap::new();

    for (entry_idx, entry) in entries.iter().enumerate() {
        if entry.district.is_none() && entry.ward.is_none() {
            for &alias in entry.aliases {
                province_scope_map.insert(alias, entry.province);
            }
            for &short in entry.short_aliases {
                province_scope_map.insert(short, entry.province);
            }
        }
        for &alias in entry.aliases {
            let first_end = scan_alnum_end(alias, 0);
            if first_end > 0 {
                let first = &alias[..first_end];
                let next_byte = alias.as_bytes().get(first_end + 1).copied().unwrap_or(0);
                let next_byte2 = alias.as_bytes().get(first_end + 2).copied().unwrap_or(0);
                raw_by_first_word.entry(first).or_default().push((
                    alias,
                    CompiledAlias {
                        entry_idx,
                        is_short: false,
                        next_byte,
                        next_byte2,
                    },
                ));
            }
        }
        for &short in entry.short_aliases {
            let first_end = scan_alnum_end(short, 0);
            if first_end > 0 {
                let first = &short[..first_end];
                let next_byte = short.as_bytes().get(first_end + 1).copied().unwrap_or(0);
                let next_byte2 = short.as_bytes().get(first_end + 2).copied().unwrap_or(0);
                raw_by_first_word.entry(first).or_default().push((
                    short,
                    CompiledAlias {
                        entry_idx,
                        is_short: true,
                        next_byte,
                        next_byte2,
                    },
                ));
            }
        }
    }

    let mut first_word_mask = [0u64; 256];
    let mut first_two_mask = [0u128; 128];
    let mut by_first_word: FastStaticWordMap<FirstWordBucket> =
        FastStaticWordMap::with_capacity(raw_by_first_word.len());
    for (word, mut list) in raw_by_first_word {
        let wb = word.as_bytes();
        if let Some(&b0) = wb.first() {
            first_word_mask[b0 as usize] |= 1u64 << word.len().min(63);
            let b1 = wb.get(1).copied().unwrap_or(0);
            if b0 < 128 && b1 < 128 {
                first_two_mask[b0 as usize] |= 1u128 << b1;
            }
        }
        list.sort_by(|a, b| {
            b.0.len()
                .cmp(&a.0.len())
                .then_with(|| a.1.is_short.cmp(&b.1.is_short))
        });
        let mut has_short_phrase = false;
        let mut next_byte_mask = 0u128;
        for &(_, meta) in &list {
            if meta.next_byte == 0 {
                has_short_phrase = true;
            } else if meta.next_byte < 128 {
                next_byte_mask |= 1u128 << meta.next_byte;
            }
        }
        by_first_word.insert(
            word,
            FirstWordBucket {
                has_short_phrase,
                next_byte_mask,
                items: list,
            },
        );
    }

    GazetteerIndex {
        entries,
        first_word_mask,
        first_two_mask,
        by_first_word,
        province_scope_map,
    }
}
