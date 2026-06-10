/**
 * StockBattle — GAS 서버 로직 (싱글 + 멀티)
 *
 * 역할:
 *   ① getSeedPrice  : 게임 시작 시 실제 시세 1회 호출(시드). 실패하면 폴백값.
 *   ② saveResult    : 게임 종료 시 결과를 Sheets에 PENDING 상태로 저장.
 *   ③ processPendingEmails : 1분 트리거가 PENDING을 스캔해 이메일+Slack 발송 후 SENT 표시.
 *
 * 가격 시뮬레이션(랜덤워크)은 전부 클라이언트(JavaScript.html)에서 돈다.
 *
 * ── 최초 1회 세팅 ──
 *   1) 스프레드시트 ID를 SPREADSHEET_ID에 넣기
 *   2) setupSpreadsheet 실행 (시트/헤더 생성)  ※기존 시트가 있으면 데이터가 지워짐
 *      - 데이터 보존하며 새 컬럼(gameId, chartData)을 추가하려면 setupSpreadsheet 대신 addNewColumns 실행
 *   3) createEmailTrigger 실행 (1분 트리거 설치)
 *   4) 배포 > 웹 앱: "나로 실행", 액세스 "링크가 있는 모든 사용자"
 */

// ===== 설정 =====
const SPREADSHEET_ID = "1V_YTLSziDDVP5DQURLX2Y_AEpqYOotVBqzznu81B3YM";
const SLACK_WEBHOOK_URL = ""; // 예: https://hooks.slack.com/services/...  (비우면 Slack 생략)
const RESULT_SHEET = "Results";
const START_MONEY = 1000000; // 시작 가상 머니 (UI 표시용 동기화)
const MAX_PLAYERS = 8; // 방 정원
const GHOST_TIMEOUT_MS = 15000; // 이 시간 이상 갱신 없는 플레이어는 유령으로 간주

// ===== Gemini (AI) =====
// 무료 티어는 모델마다 일일 쿼터(RPD)가 따로 잡힘 → 429 뜨면 다음 모델로 폴백.
// 성능 좋은 순 → 쿼터 여유 순. (2.0 계열은 2026-06-01 셧다운으로 제외)
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-flash",
  "gemini-3.1-flash-lite",
];

// ===== 웹앱 진입점 =====
function doGet(e) {
  var t = HtmlService.createTemplateFromFile("Index");
  t.roomParam = e && e.parameter && e.parameter.room ? e.parameter.room : "";
  return t
    .evaluate()
    .setTitle("StockBattle")
    .addMetaTag(
      "viewport",
      "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
    )
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Index.html 안에서 CSS/JS 파셜을 끼워넣는 헬퍼 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ===== ① 시드 시세 =====
function getSeedPrice(category, symbol) {
  try {
    if (category === "coin") {
      var url =
        "https://api.coingecko.com/api/v3/simple/price?ids=" +
        encodeURIComponent(symbol) +
        "&vs_currencies=krw";
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var data = JSON.parse(res.getContentText());
      var p = data[symbol] && data[symbol].krw;
      if (p) return { price: p, source: "CoinGecko" };
    } else {
      var u =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(symbol);
      var r = UrlFetchApp.fetch(u, {
        muteHttpExceptions: true,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      var d = JSON.parse(r.getContentText());
      var price = d.chart.result[0].meta.regularMarketPrice;
      if (price) return { price: price, source: "YahooFinance" };
    }
  } catch (e) {
    // 무시하고 폴백으로
  }
  return { price: fallbackPrice_(symbol), source: "fallback" };
}

function fallbackPrice_(symbol) {
  var map = {
    "000660.KS": 235000,
    "005930.KS": 78000,
    "035720.KS": 42000,
    "035420.KS": 180000,
    AAPL: 230,
    TSLA: 350,
    NVDA: 140,
    MSFT: 430,
    bitcoin: 95000000,
    ethereum: 4800000,
    solana: 320000,
    ripple: 3500,
  };
  return map[symbol] || 100000;
}

// 여러 종목 시드 시세를 한 번에 (게임 시작 시 1회)
function getSeedPrices(items) {
  return items.map(function (it) {
    return {
      symbol: it.symbol,
      price: getSeedPrice(it.category, it.symbol).price,
    };
  });
}

// ===== ② 결과 저장 =====
/**
 * payload: {nickname,email,mode,symbolLabel,leverage,durationMin,finalReturn,rank,totalPlayers,gameId}
 * @return {string} 저장된 행의 id
 */
function saveResult(payload) {
  var sheet = getResultSheet_();
  var id = Utilities.getUuid();
  sheet.appendRow([
    id,
    new Date(),
    payload.nickname || "익명",
    payload.email || "",
    payload.mode || "single",
    payload.symbolLabel || "",
    payload.leverage || 1,
    payload.durationMin || 5,
    Number(payload.finalReturn).toFixed(2),
    payload.rank,
    payload.totalPlayers,
    payload.feedback || "",
    payload.detail || "",
    "PENDING",
    payload.gameId || "", // 같은 게임(멀티 한 라운드/싱글 한 판)을 묶는 키
    payload.chartData || "", // 수익률 추이 + 거래 로그 JSON (상세화면 시각화용)
  ]);
  return id;
}

/** 내 기록 히스토리 (닉네임 기준 최근 20개) — 구버전 단일 리스트용(현재 미사용, 보존) */
function getHistory(nickname) {
  var sheet = getResultSheet_();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0];
  var out = [];
  for (var r = values.length - 1; r >= 1 && out.length < 20; r--) {
    var o = rowToObj_(header, values[r]);
    if (!nickname || o.nickname === nickname) {
      out.push({
        id: o.id,
        date: Utilities.formatDate(
          new Date(o.timestamp),
          Session.getScriptTimeZone(),
          "MM.dd HH:mm",
        ),
        mode: o.mode,
        nickname: o.nickname,
        symbol: o.symbolLabel,
        leverage: o.leverage,
        finalReturn: o.finalReturn,
        rank: o.rank,
        totalPlayers: o.totalPlayers,
      });
    }
  }
  return out;
}

// 기록을 게임 단위로 묶어 반환 (최신 30게임). 한 게임에 참가자 여러 명.
function getHistoryGames() {
  var sheet = getResultSheet_();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0];
  var tz = Session.getScriptTimeZone();
  var groups = {},
    order = [];
  for (var r = values.length - 1; r >= 1; r--) {
    // 최신부터
    var o = rowToObj_(header, values[r]);
    var key = groupKeyOf_(o, tz);
    if (!groups[key]) {
      groups[key] = {
        mode: o.mode,
        symbol: o.symbolLabel,
        leverage: o.leverage,
        durationMin: o.durationMin,
        timestamp: o.timestamp,
        players: [],
      };
      order.push(key);
    }
    groups[key].players.push({
      id: o.id,
      nickname: o.nickname,
      rank: Number(o.rank),
      finalReturn: o.finalReturn,
    });
  }
  return order.slice(0, 30).map(function (k) {
    var g = groups[k];
    g.players.sort(function (a, b) {
      return a.rank - b.rank;
    });
    return {
      mode: g.mode,
      symbol: g.symbol,
      leverage: g.leverage,
      durationMin: g.durationMin,
      date: Utilities.formatDate(new Date(g.timestamp), tz, "MM.dd HH:mm"),
      count: g.players.length,
      players: g.players,
    };
  });
}

// 그룹 키: gameId 있으면 그걸로(정확). 없는 옛 멀티 기록은 설정+분 단위로 묶고, 옛 싱글은 각자.
function groupKeyOf_(o, tz) {
  if (o.gameId) return "g|" + o.gameId;
  if (o.mode === "multi") {
    var min = Utilities.formatDate(new Date(o.timestamp), tz, "yyyyMMddHHmm");
    return (
      "m|" +
      o.symbolLabel +
      "|" +
      o.leverage +
      "|" +
      o.durationMin +
      "|" +
      o.totalPlayers +
      "|" +
      min
    );
  }
  return "s|" + o.id;
}

// 게임 종료 통합: AI 피드백 생성 → 결과+피드백+상세 저장 → 피드백 문자열 반환
function finishGame(payload) {
  var fb = "";
  try {
    fb = aiFeedback(payload.summary, payload.nickname) || "";
  } catch (e) {
    fb = "";
  }
  payload.feedback = fb;
  payload.detail = payload.summary || "";
  saveResult(payload);
  return fb;
}

// 기록 상세 1건 조회
function getGameDetail(id) {
  var sheet = getResultSheet_();
  var values = sheet.getDataRange().getValues();
  var header = values[0];
  for (var r = 1; r < values.length; r++) {
    var o = rowToObj_(header, values[r]);
    if (o.id === id) {
      return {
        nickname: o.nickname,
        date: Utilities.formatDate(
          new Date(o.timestamp),
          Session.getScriptTimeZone(),
          "MM.dd HH:mm",
        ),
        mode: o.mode,
        symbol: o.symbolLabel,
        leverage: o.leverage,
        durationMin: o.durationMin,
        finalReturn: o.finalReturn,
        rank: o.rank,
        totalPlayers: o.totalPlayers,
        feedback: o.feedback,
        detail: o.detail,
        chartData: o.chartData,
      };
    }
  }
  return null;
}

// ===== ③ 트리거: PENDING 스캔 → 이메일 + Slack =====
function processPendingEmails() {
  var sheet = getResultSheet_();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  var header = values[0];
  var statusCol = header.indexOf("EMAIL_STATUS");

  for (var r = 1; r < values.length; r++) {
    if (values[r][statusCol] !== "PENDING") continue;
    var data = rowToObj_(header, values[r]);
    var newStatus = "SENT";
    try {
      if (data.email) sendResultEmail_(data);
      else newStatus = "NO_EMAIL";
      postSlack_(data);
    } catch (e) {
      newStatus = "ERROR";
    }
    sheet.getRange(r + 1, statusCol + 1).setValue(newStatus);
  }
}

// AI 피드백을 메일용 HTML 블록으로 (라벨 칩 분리, 없으면 줄바꿈)
function feedbackToHtml_(raw) {
  if (!raw) return "";
  var s = String(raw).trim();
  // 라벨/시간대 앞 줄바꿈 (클라 formatFeedback과 동일 규칙)
  s = s.replace(/\s*(\[(?:사실|해석|조언)\])/g, function (m, tag, off) {
    return off === 0 ? tag : "\n" + tag;
  });
  s = s.replace(/\s*(\[\d{1,2}:\d{2}\])/g, function (m, tag, off) {
    return off === 0 ? tag : "\n" + tag;
  });
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  var hasLabel = /\[(사실|해석|조언)\]/.test(s);
  if (!hasLabel) {
    return (
      '<div style="font-size:15px;line-height:1.7;color:#191f28">' +
      esc_(s).replace(/\n/g, "<br>") +
      "</div>"
    );
  }
  var out = "";
  var firstIdx = s.search(/\[(사실|해석|조언)\]/);
  if (firstIdx > 0) {
    var intro = s.slice(0, firstIdx).trim();
    if (intro)
      out +=
        '<div style="font-size:15px;line-height:1.65;color:#191f28;font-weight:600;margin-bottom:10px">' +
        esc_(intro) +
        "</div>";
  }
  var rest = s.slice(firstIdx);
  var parts = rest.split(/\n(?=\[(?:사실|해석|조언)\])/);
  var chip = {
    사실: { bg: "#e7f0ff", fg: "#1b64da" },
    해석: { bg: "#efe9ff", fg: "#6b4fd8" },
    조언: { bg: "#e3f8ee", fg: "#1a8d5f" },
  };
  parts.forEach(function (p) {
    p = p.trim();
    if (!p) return;
    var m = p.match(/^\[(사실|해석|조언)\]\s*([\s\S]*)$/);
    if (m) {
      var c = chip[m[1]];
      out +=
        '<div style="margin:10px 0">' +
        '<span style="display:inline-block;font-size:12px;font-weight:800;padding:3px 10px;border-radius:7px;background:' +
        c.bg +
        ";color:" +
        c.fg +
        '">' +
        m[1] +
        "</span>" +
        '<div style="font-size:14.5px;line-height:1.7;color:#191f28;margin-top:6px">' +
        esc_(m[2].trim()).replace(/\n/g, "<br>") +
        "</div>" +
        "</div>";
    } else {
      out +=
        '<div style="font-size:14.5px;line-height:1.7;color:#191f28;margin:8px 0">' +
        esc_(p).replace(/\n/g, "<br>") +
        "</div>";
    }
  });
  return out;
}

function sendResultEmail_(d) {
  var ret = Number(d.finalReturn);
  var sign = ret >= 0 ? "+" : "";
  var liq = ret <= -100;
  var subject =
    "[StockBattle] " +
    d.symbolLabel +
    " · " +
    (liq ? "청산" : d.rank + "위") +
    " · " +
    sign +
    d.finalReturn +
    "%";

  var L = [];
  L.push("━━━━━━━━━━━━━━━");
  L.push("  StockBattle 결과");
  L.push("━━━━━━━━━━━━━━━");
  L.push("");
  L.push(d.nickname + " 님,");
  L.push((liq ? "청산" : d.rank + "위") + " / " + d.totalPlayers + "명 중");
  L.push("최종 수익률  " + sign + d.finalReturn + "%");
  L.push("");
  L.push("· 종목      " + d.symbolLabel);
  L.push("· 레버리지  " + d.leverage + "배");
  L.push("· 게임 시간 " + d.durationMin + "분");
  L.push("");

  // AI 분석 (라벨/시간대 줄바꿈 정리된 평문)
  if (d.feedback) {
    L.push("───────────────");
    L.push("  AI 트레이딩 분석");
    L.push("───────────────");
    L.push(feedbackToPlain_(d.feedback));
    L.push("");
  }

  // 거래 내역
  var cd = null;
  try {
    if (d.chartData) cd = JSON.parse(d.chartData);
  } catch (e) {
    cd = null;
  }
  if (cd && cd.log && cd.log.length) {
    L.push("───────────────");
    L.push("  거래 내역");
    L.push("───────────────");
    L.push(tradeTimelinePlain_(cd.log));
    L.push("");
  }

  L.push("※ 가상 머니를 사용한 교육·오락용 게임입니다.");
  L.push("  실제 투자와 무관합니다.");

  MailApp.sendEmail({ to: d.email, subject: subject, body: L.join("\n") });
}

// AI 피드백 → 평문 (라벨 앞 빈 줄, [mm:ss] 앞 줄바꿈)
function feedbackToPlain_(raw) {
  var s = String(raw || "").trim();
  s = s.replace(/\s*(\[(?:사실|해석|조언)\])/g, function (m, tag, off) {
    return off === 0 ? tag : "\n\n" + tag;
  });
  s = s.replace(/\s*(\[\d{1,2}:\d{2}\])/g, function (m, tag, off) {
    return off === 0 ? tag : "\n" + tag;
  });
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// 거래 로그 → 평문 타임라인
function tradeTimelinePlain_(log) {
  return log
    .map(function (e) {
      var t = mailTime_(e.sec),
        price = mailMoney_(e.price, e.cur),
        s = "";
      if (e.type === "buy")
        s = "매수  " + e.label + " " + price + " (" + e.lev + "배)";
      else if (e.type === "sell")
        s =
          "매도  " +
          e.label +
          " " +
          price +
          (e.pnl != null
            ? "  손익 " +
              (e.pnl >= 0 ? "+" : "") +
              Number(e.pnl).toLocaleString("en-US")
            : "");
      else if (e.type === "levup") s = "레버리지  " + e.lev + "배로 상향";
      else if (e.type === "liq") s = "청산  " + e.label + " " + price;
      else return "";
      return "[" + t + "] " + s;
    })
    .filter(Boolean)
    .join("\n");
}

// 2단 fluid hybrid: 600px↑면 좌우, 좁으면 세로로 쌓임. 한쪽이 비면 다른 쪽만 풀폭.
function twoCol_(left, right) {
  if (!left && !right) return "";
  if (!left || !right) {
    return '<div style="margin:0">' + (left || right) + "</div>";
  }
  return (
    "" +
    '<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%" valign="top" style="padding-right:7px"><![endif]-->' +
    '<div style="display:inline-block;vertical-align:top;width:100%;max-width:286px;margin:0 0 14px">' +
    left +
    "</div>" +
    '<!--[if mso]></td><td width="50%" valign="top" style="padding-left:7px"><![endif]-->' +
    '<div style="display:inline-block;vertical-align:top;width:100%;max-width:286px;margin:0 0 14px">' +
    right +
    "</div>" +
    "<!--[if mso]></td></tr></table><![endif]-->"
  );
}
function gap_() {
  return '<div style="height:14px;line-height:14px;font-size:0">&nbsp;</div>';
}

function esc_(x) {
  return String(x == null ? "" : x)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function infoRow_(label, val) {
  return (
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid #f2f4f6">' +
    '<span style="font-size:14px;color:#8b95a1;font-weight:600">' +
    label +
    "</span>" +
    '<span style="font-size:15px;color:#191f28;font-weight:700">' +
    esc_(val) +
    "</span></div>"
  );
}
function infoRowLast_(label, valHtml) {
  return (
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0 0">' +
    '<span style="font-size:14px;color:#8b95a1;font-weight:600">' +
    label +
    "</span>" +
    '<span style="font-size:15px">' +
    valHtml +
    "</span></div>"
  );
}

// 추이 배열을 최대 maxN개로 균등 다운샘플 (QuickChart URL 길이 안전 관리)
function downsample_(arr, maxN) {
  if (!arr || arr.length <= maxN) return arr || [];
  var out = [],
    step = (arr.length - 1) / (maxN - 1);
  for (var i = 0; i < maxN; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// 수익률 추이 → QuickChart 라인차트 이미지 URL (canvas/JS 못 쓰는 메일용)
// 선은 단색, 0% 기준선을 점선으로 굵게 → "물려있던 구간"이 보이게.
function retChartUrl_(retSeries, win) {
  var data = downsample_(retSeries, 60).map(function (v) {
    return Math.round(Number(v) * 100) / 100;
  });
  if (data.length < 2) return "";
  var line = win ? "#f04452" : "#3182f6";
  var fill = win ? "rgba(240,68,82,0.10)" : "rgba(49,130,246,0.10)";
  var cfg = {
    type: "line",
    data: {
      labels: data.map(function () {
        return "";
      }),
      datasets: [
        {
          data: data,
          borderColor: line,
          backgroundColor: fill,
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          tension: 0.3,
        },
      ],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ display: false }],
        yAxes: [
          {
            ticks: { fontColor: "#8b95a1", fontSize: 10, callback: undefined },
            gridLines: { color: "#eef1f4" },
          },
        ],
      },
      annotation: {
        annotations: [
          {
            type: "line",
            mode: "horizontal",
            scaleID: "y-axis-0",
            value: 0,
            borderColor: "#b0b8c1",
            borderWidth: 1.5,
            borderDash: [5, 4],
          },
        ],
      },
    },
  };
  return (
    "https://quickchart.io/chart?w=440&h=200&bkg=white&c=" +
    encodeURIComponent(JSON.stringify(cfg))
  );
}

// 거래 내역 → 메일용 타임라인 HTML (canvas 없이 순수 HTML)
function tradeTimelineHtml_(log) {
  if (!log || !log.length) {
    return '<div style="font-size:14px;color:#8b95a1;text-align:center;padding:8px 0">거래 없음 (관망)</div>';
  }
  var chip = {
    buy: { bg: "#ffe9eb", fg: "#f04452", t: "매수" },
    sell: { bg: "#e7f0ff", fg: "#1b64da", t: "매도" },
    levup: { bg: "#fff0db", fg: "#d97a06", t: "레버리지" },
    liq: { bg: "#efe9ff", fg: "#6b4fd8", t: "청산" },
  };
  var rows = log
    .map(function (e) {
      var c = chip[e.type];
      if (!c) return "";
      var price = mailMoney_(e.price, e.cur);
      var main = "";
      if (e.type === "buy")
        main = esc_(e.label) + " " + price + "에 매수 · " + e.lev + "배";
      else if (e.type === "sell")
        main = esc_(e.label) + " " + price + "에 매도";
      else if (e.type === "levup") main = "레버리지 " + e.lev + "배로 상향";
      else if (e.type === "liq")
        main = esc_(e.label) + " " + price + "에서 청산";
      var pnl = "";
      if (e.type === "sell" && e.pnl != null) {
        var pc = e.pnl >= 0 ? "#f04452" : "#3182f6";
        pnl =
          '<span style="font-size:13px;font-weight:700;color:' +
          pc +
          ';white-space:nowrap">' +
          (e.pnl >= 0 ? "+" : "") +
          Number(e.pnl).toLocaleString("en-US") +
          "</span>";
      }
      return (
        "<tr>" +
        '<td style="padding:7px 0;font-size:12px;color:#8b95a1;width:46px;vertical-align:top">' +
        mailTime_(e.sec) +
        "</td>" +
        '<td style="padding:7px 6px;width:60px;vertical-align:top"><span style="display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;background:' +
        c.bg +
        ";color:" +
        c.fg +
        '">' +
        c.t +
        "</span></td>" +
        '<td style="padding:7px 0;font-size:13px;color:#191f28;vertical-align:top">' +
        main +
        "</td>" +
        '<td style="padding:7px 0;text-align:right;vertical-align:top">' +
        pnl +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
  return (
    '<table style="width:100%;border-collapse:collapse">' + rows + "</table>"
  );
}

function mailTime_(s) {
  s = Math.max(0, Number(s) || 0);
  var m = Math.floor(s / 60),
    ss = s % 60;
  return (m < 10 ? "0" + m : m) + ":" + (ss < 10 ? "0" + ss : ss);
}
function mailMoney_(n, cur) {
  var v = Math.round(Number(n) || 0).toLocaleString("en-US");
  if (cur === "usd") return "$" + v;
  if (cur === "krw") return v + "원";
  return v;
}

function postSlack_(d) {
  if (!SLACK_WEBHOOK_URL) return;
  var text =
    ":chart_with_upwards_trend: *StockBattle 결과*\n" +
    "> *" +
    d.nickname +
    "* — " +
    d.symbolLabel +
    " / " +
    d.leverage +
    "배\n" +
    "> 수익률 *" +
    d.finalReturn +
    "%* · " +
    d.rank +
    "/" +
    d.totalPlayers +
    "위";
  UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
}

// ===== 헬퍼 =====
function getResultSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(RESULT_SHEET);
  if (!sheet) sheet = setupSpreadsheet();
  return sheet;
}

function rowToObj_(header, row) {
  var o = {};
  for (var i = 0; i < header.length; i++) o[header[i]] = row[i];
  return o;
}

// ===== 최초 1회 실행 (주의: 기존 데이터 삭제) =====
function setupSpreadsheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(RESULT_SHEET) || ss.insertSheet(RESULT_SHEET);
  sheet.clear();
  sheet.appendRow([
    "id",
    "timestamp",
    "nickname",
    "email",
    "mode",
    "symbolLabel",
    "leverage",
    "durationMin",
    "finalReturn",
    "rank",
    "totalPlayers",
    "feedback",
    "detail",
    "EMAIL_STATUS",
    "gameId",
    "chartData",
  ]);
  sheet.getRange(1, 1, 1, 16).setFontWeight("bold");
  sheet.setFrozenRows(1);

  // 멀티용 시트
  var rooms = ss.getSheetByName("Rooms") || ss.insertSheet("Rooms");
  rooms.clear();
  rooms.appendRow([
    "roomId",
    "seed",
    "category",
    "leverage",
    "durationMin",
    "status",
    "startTime",
    "news",
    "host",
    "createdAt",
    "round",
  ]);
  rooms.getRange(1, 1, 1, 11).setFontWeight("bold");
  rooms.setFrozenRows(1);

  var players = ss.getSheetByName("Players") || ss.insertSheet("Players");
  players.clear();
  players.appendRow([
    "roomId",
    "nick",
    "state",
    "finished",
    "updatedAt",
    "email",
  ]);
  players.getRange(1, 1, 1, 6).setFontWeight("bold");
  players.setFrozenRows(1);

  return sheet;
}

// 기존 시트에 새 컬럼(gameId, chartData)만 추가 (데이터 보존). 편집기에서 1회 실행.
function addNewColumns() {
  var sheet = getResultSheet_();
  ["gameId", "chartData"].forEach(function (name) {
    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (header.indexOf(name) === -1) {
      sheet
        .getRange(1, sheet.getLastColumn() + 1)
        .setValue(name)
        .setFontWeight("bold");
    }
  });
}

// Players 시트에 email 컬럼(6번째)만 추가 (데이터 보존). 멀티 이메일 받기용. 편집기에서 1회 실행.
function addPlayerEmailColumn() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  if (!players) return;
  var header = players
    .getRange(1, 1, 1, players.getLastColumn())
    .getValues()[0];
  if (header.indexOf("email") === -1) {
    players
      .getRange(1, players.getLastColumn() + 1)
      .setValue("email")
      .setFontWeight("bold");
  }
}

function createEmailTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "processPendingEmails")
      ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("processPendingEmails")
    .timeBased()
    .everyMinutes(1)
    .create();
}

// ===== AI: Gemini 호출 (모델 폴백 체인) =====
// 한 모델이 429/5xx로 막히면 다음 모델로 자동 폴백. 무료 티어 쿼터 분산용.
// 각 모델은 기존과 동일하게 429/5xx 시 2회까지 재시도 후 다음 모델로 넘어감.
function callGemini_(prompt, jsonMode, temp) {
  var key =
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) return null; // 키 없으면 클라이언트가 로컬 폴백 사용

  for (var m = 0; m < GEMINI_MODELS.length; m++) {
    var model = GEMINI_MODELS[m];
    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent";
    var gen = { temperature: temp == null ? 0.9 : temp, maxOutputTokens: 4096 };
    if (model.indexOf("gemini-2.") === 0)
      gen.thinkingConfig = { thinkingBudget: 0 };
    if (jsonMode) gen.responseMimeType = "application/json";
    var opt = {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": key },
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: gen,
      }),
      muteHttpExceptions: true,
    };

    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var res = UrlFetchApp.fetch(url, opt);
        var code = res.getResponseCode();
        if (code === 429 || code >= 500) {
          Utilities.sleep(1500);
          continue;
        } // 쿼터/일시오류 → 재시도
        var data = JSON.parse(res.getContentText());
        var cand = data.candidates && data.candidates[0];
        if (cand && cand.content && cand.content.parts) {
          var txt = cand.content.parts
            .map(function (p) {
              return p.text || "";
            })
            .join("")
            .trim();
          if (txt) return txt; // 성공
        }
        break; // 응답은 왔으나 빈 결과 → 같은 모델 재시도 말고 다음 모델로
      } catch (e) {
        Utilities.sleep(800);
      }
    }
    // 이 모델 실패(429 소진/빈 응답/예외) → 다음 모델로 폴백
  }
  return null; // 모든 모델 실패 → 클라이언트 로컬 폴백
}

// 시작 시: 시황 브리핑 + 종목별 속보 헤드라인 생성
function aiMarketNews(category, items) {
  var lines = items
    .map(function (it, i) {
      return i + 1 + ". " + it.label + " / " + (it.dir > 0 ? "호재" : "악재");
    })
    .join("\n");
  var prompt =
    "너는 가상 주식 게임의 시황 작가다. 실제 사실이 아닌, 게임용 가상 뉴스를 쓴다.\n" +
    "시장: " +
    category +
    "\n아래 각 항목에 대해 한국어 속보 헤드라인을 한 줄씩 써라(종목명 포함, 이모지 접두사 없이, 25자 내외, 방향에 맞게).\n" +
    lines +
    "\n" +
    "또 전체 분위기를 요약한 한 줄 시황(brief)도 써라.\n" +
    'JSON만 출력: {"brief":"...","heads":["1번 헤드라인","2번 헤드라인", ...]}';
  var txt = callGemini_(prompt, true);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

// 종료 시: 거래 기록 기반 피드백 (사실은 지어내지 않되, 해석·개선 조언은 적극적으로)
function aiFeedback(summary, nickname) {
  var who = nickname || "플레이어";
  var prompt =
    "너는 트레이딩 코치다. 아래 한 판의 거래 기록과 결과를 근거로, 다음 판에 더 잘하도록 돕는 피드백을 써라.\n" +
    '맨 앞을 "' +
    who +
    '님,"으로 시작하고, 한 문장으로 이번 판을 요약하라.\n\n' +
    '★ 시간 표기 규칙(매우 중요): 기록의 [mm:ss]는 게임 시작 후 "경과 시간"이며 분:초 단위다. 예: [00:21]=21초, [01:35]=1분 35초. 절대 "00시 21분"처럼 시각(시/분)으로 바꿔 쓰지 마라. 그대로 [mm:ss]로 인용하라.\n\n' +
    "아래 세 라벨을 반드시 이 순서로, 라벨 텍스트도 정확히 붙여서 써라:\n" +
    '[사실] 거래내역에 실제로 적힌 행동을 시간순으로 나열한다. 각 행동을 "[mm:ss] 무엇을 했다" 한 줄씩, 줄바꿈으로 구분해 써라(한 줄에 몰아쓰지 마라). 기록에 없는 행동(손절·추가매수 등)이나 감정(당황·욕심)은 절대 지어내지 마라.\n' +
    "[해석] 그 결정들이 결과(수익률·순위·청산)로 어떻게 이어졌는지, 가장 핵심 원인 1가지를 2~3문장으로 짚어라. 한 문단으로 쓰되 사실 나열 반복은 금지. 예: 뉴스 방향과 엇갈린 매매, 손실 구간 레버리지 상향, 종목 갈아타기 타이밍.\n" +
    '[조언] 다음 판에 바로 적용할 구체적 개선점 1가지를 2~3문장으로 제시하라. "힘내세요" 같은 추상적 격려 금지. 어떤 상황에서 어떤 행동을 하라는 식으로 행동 단위로 써라.\n\n' +
    "전체 규칙: 존댓말 평문, 마크다운(*, #) 금지. [사실]만 여러 줄, [해석]·[조언]은 각각 한 문단.\n\n" +
    summary;
  return callGemini_(prompt, false, 0.4);
}

// ===================== 멀티플레이 =====================
function genRoomCode_() {
  var c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    s = "";
  for (var i = 0; i < 5; i++)
    s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}

// 방 생성. opts: {category, leverage, durationMin, host, labels:[종목명...]}
// AI 뉴스 생성은 동기 제거 → 빈 뉴스({})로 즉시 생성.
// 클라이언트가 방 생성 직후 prepareRoomNews를 fire-and-forget으로 호출해 채움.
function createRoom(opts) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rooms = ss.getSheetByName("Rooms");
  var players = ss.getSheetByName("Players");
  var roomId = genRoomCode_();
  var seed = Math.floor(Math.random() * 0x7fffffff);
  rooms.appendRow([
    roomId,
    seed,
    opts.category,
    opts.leverage,
    opts.durationMin,
    "waiting",
    "",
    JSON.stringify({}),
    opts.host || "방장",
    new Date(),
    0,
  ]);
  players.appendRow([
    roomId,
    opts.host || "방장",
    "",
    false,
    new Date(),
    opts.email || "",
  ]);
  var url = "";
  try {
    url = ScriptApp.getService().getUrl() + "?room=" + roomId;
  } catch (e) {}
  return { roomId: roomId, inviteUrl: url };
}

// 대기실에서 방장이 게임 조건 변경. status==='waiting'일 때만 허용.
// 카테고리 변경 시 news를 {}로 초기화(클라가 prepareRoomNews 재호출).
function updateRoomSettings(roomId, opts) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rooms = ss.getSheetByName("Rooms");
  var vals = rooms.getDataRange().getValues();
  var h = vals[0];
  var ic = h.indexOf("roomId"),
    sc = h.indexOf("status");
  var cc = h.indexOf("category"),
    lc = h.indexOf("leverage"),
    dc = h.indexOf("durationMin"),
    nc = h.indexOf("news");
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][ic]) !== String(roomId)) continue;
    if (String(vals[r][sc]) !== "waiting") return { error: "NOT_WAITING" };
    var categoryChanged = String(vals[r][cc]) !== String(opts.category);
    if (cc >= 0) rooms.getRange(r + 1, cc + 1).setValue(opts.category);
    if (lc >= 0) rooms.getRange(r + 1, lc + 1).setValue(opts.leverage);
    if (dc >= 0) rooms.getRange(r + 1, dc + 1).setValue(opts.durationMin);
    if (categoryChanged && nc >= 0)
      rooms.getRange(r + 1, nc + 1).setValue(JSON.stringify({}));
    return { ok: true };
  }
  return { error: "NOT_FOUND" };
}

// 방 생성 직후 클라가 비동기로 호출 → Rooms.news 컬럼에 AI 헤드라인 채움.
// 대기실 폴링(getLobby)이 news를 실어 나르므로 게임 시작 전에 전원이 같은 뉴스를 받음.
function prepareRoomNews(roomId, category, labels) {
  var news = aiRoomNews_(category, labels || []);
  if (!news || !Object.keys(news).length) return false;
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rooms = ss.getSheetByName("Rooms");
  var vals = rooms.getDataRange().getValues();
  var h = vals[0];
  var ic = h.indexOf("roomId"),
    nc = h.indexOf("news");
  if (ic < 0 || nc < 0) return false;
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][ic]) === String(roomId)) {
      rooms.getRange(r + 1, nc + 1).setValue(JSON.stringify(news));
      return true;
    }
  }
  return false;
}

// 입장
function joinRoom(roomId, nick, email) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var room = findRoom_(ss, roomId);
  if (!room) return { error: "NOT_FOUND" };
  if (room.status !== "waiting") return { error: "ALREADY_STARTED" };
  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
  var count = 0;
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) === String(roomId)) {
      count++;
      if (String(vals[r][1]) === String(nick)) return { error: "NICK_TAKEN" };
    }
  }
  if (count >= MAX_PLAYERS) return { error: "ROOM_FULL" };
  players.appendRow([roomId, nick, "", false, new Date(), email || ""]);
  return roomBasic_(room);
}

// 방 나가기: 해당 플레이어 행 제거 (다시하기 안 누르고 홈으로/나가기 시 진짜 나감)
// 나가는 사람이 방장이면, 남은 플레이어 중 가장 먼저 들어온 사람에게 방장 위임.
function leaveRoom(roomId, nick) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  if (!players) return { ok: false };
  var vals = players.getDataRange().getValues();
  // 아래에서 위로 삭제해야 인덱스가 안 밀림(중복 행 대비)
  for (var r = vals.length - 1; r >= 1; r--) {
    if (
      String(vals[r][0]) === String(roomId) &&
      String(vals[r][1]) === String(nick)
    ) {
      players.deleteRow(r + 1);
    }
  }
  // 방장이 나갔으면 위임 처리
  reassignHostIfNeeded_(ss, roomId, nick);
  return { ok: true };
}

// 떠난 사람이 방장이었으면, 남은 플레이어 중 가장 먼저 들어온(행이 위인) 사람을 새 방장으로.
function reassignHostIfNeeded_(ss, roomId, leftNick) {
  var room = findRoom_(ss, roomId);
  if (!room) return; // 방이 이미 없음
  if (String(room.host) !== String(leftNick)) return; // 떠난 사람이 방장이 아니면 할 일 없음

  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
  var newHost = null;
  for (var r = 1; r < vals.length; r++) {
    // 위→아래 = 먼저 들어온 순
    if (String(vals[r][0]) === String(roomId)) {
      newHost = String(vals[r][1]);
      break;
    }
  }
  var rooms = ss.getSheetByName("Rooms");
  var rv = rooms.getDataRange().getValues();
  var h = rv[0];
  var ic = h.indexOf("roomId"),
    hc = h.indexOf("host");
  for (var i = 1; i < rv.length; i++) {
    if (String(rv[i][ic]) === String(roomId)) {
      if (newHost) rooms.getRange(i + 1, hc + 1).setValue(newHost); // 남은 사람 있으면 위임
      // 남은 사람이 없으면 host는 그대로 둠(빈 방은 다음 입장 시 정리/무의미)
      break;
    }
  }
}

// 대기실/게임 상태 조회 (폴링용)
function getLobby(roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var room = findRoom_(ss, roomId);
  if (!room) return { error: "NOT_FOUND" };

  var alive = getRoomPlayers(roomId); // 유령 제외된 명단
  // host가 살아있는 명단에 없으면, 명단 첫 사람(가장 먼저 들어온 순)에게 위임
  var host = room.host;
  var hostAlive = alive.some(function (p) {
    return String(p.nick) === String(host);
  });
  if (!hostAlive && alive.length) {
    host = alive[0].nick;
    setRoomHost_(ss, roomId, host); // 필요할 때만 쓰기
  }

  return {
    status: room.status,
    startTime: room.startTime ? new Date(room.startTime).getTime() : 0,
    host: host,
    category: room.category,
    leverage: room.leverage,
    durationMin: room.durationMin,
    seed: Number(room.seed),
    news: room.news ? JSON.parse(room.news) : {},
    inviteUrl: inviteUrl_(roomId),
    serverNow: Date.now(),
    players: alive,
  };
}

// host 필드만 갱신 (위임 전용)
function setRoomHost_(ss, roomId, newHost) {
  var rooms = ss.getSheetByName("Rooms");
  var rv = rooms.getDataRange().getValues();
  var h = rv[0];
  var ic = h.indexOf("roomId"),
    hc = h.indexOf("host");
  for (var i = 1; i < rv.length; i++) {
    if (String(rv[i][ic]) === String(roomId)) {
      if (String(rv[i][hc]) !== String(newHost))
        rooms.getRange(i + 1, hc + 1).setValue(newHost);
      break;
    }
  }
}

// 게임 시작/재시작 (방장) → 새 시드·새 시작시각·플레이어 리셋
function startRoom(roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rooms = ss.getSheetByName("Rooms");
  var vals = rooms.getDataRange().getValues();
  var h = vals[0];
  var sc = h.indexOf("status"),
    tc = h.indexOf("startTime"),
    ic = h.indexOf("roomId"),
    seedc = h.indexOf("seed");
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][ic]) === String(roomId)) {
      var st = new Date(Date.now() + 2500);
      var newSeed = Math.floor(Math.random() * 0x7fffffff);
      rooms.getRange(r + 1, sc + 1).setValue("playing");
      rooms.getRange(r + 1, tc + 1).setValue(st);
      if (seedc >= 0) rooms.getRange(r + 1, seedc + 1).setValue(newSeed);
      resetRoomPlayers_(ss, roomId);
      return { startTime: st.getTime(), seed: newSeed };
    }
  }
  return { error: "NOT_FOUND" };
}
function resetRoomPlayers_(ss, roomId) {
  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) === String(roomId))
      players.getRange(r + 1, 3, 1, 3).setValues([["", false, new Date()]]);
  }
}

// 내 포지션 상태 갱신 + 전체 명단 반환
function updatePlayer(roomId, nick, state, finished) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {
    if (
      String(vals[r][0]) === String(roomId) &&
      String(vals[r][1]) === String(nick)
    ) {
      players
        .getRange(r + 1, 3, 1, 3)
        .setValues([[state, finished, new Date()]]);
      break;
    }
  }
  return getRoomPlayers(roomId);
}

// 생존 신호(하트비트): updatedAt(5번째 컬럼)만 갱신. 대기실에서 유령 오판정 방지.
function touchPlayer(roomId, nick) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  if (!players) return false;
  var vals = players.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {
    if (
      String(vals[r][0]) === String(roomId) &&
      String(vals[r][1]) === String(nick)
    ) {
      players.getRange(r + 1, 5).setValue(new Date());
      break;
    }
  }
  return true;
}

function getRoomPlayers(roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
  var now = Date.now();
  var map = {};
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) !== String(roomId)) continue;
    var nick = String(vals[r][1]);
    var t = vals[r][4] ? new Date(vals[r][4]).getTime() : 0;
    if (!map[nick] || t >= map[nick].t) {
      var st = null;
      try {
        if (vals[r][2]) st = JSON.parse(vals[r][2]);
      } catch (e) {
        st = null;
      }
      map[nick] = {
        nick: nick,
        state: st,
        finished: vals[r][3] === true || vals[r][3] === "true",
        t: t,
        email: vals[r][5] || "",
      };
    }
  }
  // 유령(15초+ 미갱신) 제외. t===0(갱신값 없는 옛/방금 데이터)은 보호.
  return Object.keys(map)
    .filter(function (k) {
      var t = map[k].t;
      return t === 0 || now - t < GHOST_TIMEOUT_MS;
    })
    .map(function (k) {
      return {
        nick: map[k].nick,
        state: map[k].state,
        finished: map[k].finished,
        email: map[k].email,
      };
    });
}

function findRoom_(ss, roomId) {
  var rooms = ss.getSheetByName("Rooms");
  var vals = rooms.getDataRange().getValues();
  var h = vals[0];
  var ic = h.indexOf("roomId");
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][ic]) === String(roomId)) return rowToObj_(h, vals[r]);
  }
  return null;
}
function roomBasic_(room) {
  return {
    roomId: room.roomId,
    seed: Number(room.seed),
    category: room.category,
    leverage: room.leverage,
    durationMin: room.durationMin,
    status: room.status,
    startTime: room.startTime ? new Date(room.startTime).getTime() : 0,
    host: room.host,
    news: room.news ? JSON.parse(room.news) : {},
    inviteUrl: inviteUrl_(room.roomId),
  };
}
function inviteUrl_(roomId) {
  try {
    return ScriptApp.getService().getUrl() + "?room=" + roomId;
  } catch (e) {
    return "";
  }
}

// 방 전용 AI 뉴스 템플릿 (종목별 호재/악재 1개씩)
function aiRoomNews_(category, labels) {
  if (!labels || !labels.length) return {};
  var prompt =
    "너는 가상 주식 게임 시황 작가다. 실제 사실이 아닌 게임용 가짜 뉴스다.\n" +
    "아래 종목 각각에 대해 호재(pos) 헤드라인 1개, 악재(neg) 헤드라인 1개를 한국어로 써라(종목명 포함, 25자 내외, 이모지 접두사 없이).\n" +
    "종목: " +
    labels.join(", ") +
    "\n" +
    'JSON만 출력: {"종목명":{"pos":"...","neg":"..."}, ...}';
  var txt = callGemini_(prompt, true);
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch (e) {
    return {};
  }
}
