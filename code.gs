/**
 * StockBattle — GAS 서버 로직 (싱글 모드 / P4 게임화면 중심)
 *
 * 역할은 딱 3가지:
 *   ① getSeedPrice  : 게임 시작 시 실제 시세 1회 호출(시드). 실패하면 폴백값.
 *   ② saveResult    : 게임 종료 시 결과를 Sheets에 PENDING 상태로 저장.
 *   ③ processPendingEmails : 1분마다 도는 설치형 트리거가 PENDING을 스캔해
 *                            이메일 + Slack 발송 후 SENT 로 표시.
 *
 * 가격 시뮬레이션(랜덤워크)은 전부 클라이언트(JavaScript.html)에서 돈다.
 * GAS는 6분 실행 한도가 있으므로 실시간 루프를 서버에 두지 않는다.
 *
 * ── 최초 1회 세팅 순서 ──
 *   1) 구글 스프레드시트 새로 만들고 URL의 /d/ 와 /edit 사이 ID 를 복사
 *   2) 아래 SPREADSHEET_ID 에 붙여넣기 (SLACK_WEBHOOK_URL 은 선택)
 *   3) 편집기 상단에서 setupSpreadsheet 실행 (시트/헤더 생성)
 *   4) createEmailTrigger 실행 (1분 트리거 설치)
 *   5) 배포 > 웹 앱: "나로 실행", 액세스 "링크가 있는 모든 사용자"
 */

// ===== 설정 =====
const SPREADSHEET_ID = "1V_YTLSziDDVP5DQURLX2Y_AEpqYOotVBqzznu81B3YM";
const SLACK_WEBHOOK_URL = ""; // 예: https://hooks.slack.com/services/...  (비우면 Slack 생략)
const RESULT_SHEET = "Results";
const START_MONEY = 1000000; // 시작 가상 머니 (UI 표시용 동기화)

// ===== 웹앱 진입점 =====
function doGet() {
  return HtmlService.createTemplateFromFile("Index")
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
/**
 * @param {string} category 'kr' | 'us' | 'coin'
 * @param {string} symbol   야후 심볼('000660.KS','AAPL') 또는 코인게코 id('bitcoin')
 * @return {{price:number, source:string}}
 */
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
    AAPL: 230,
    TSLA: 350,
    NVDA: 140,
    bitcoin: 95000000,
    ethereum: 4800000,
    solana: 320000,
  };
  return map[symbol] || 100000;
}

// ===== ② 결과 저장 =====
/**
 * payload: {nickname,email,mode,symbolLabel,leverage,durationMin,finalReturn,rank,totalPlayers}
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
    "PENDING",
  ]);
  return id;
}

/** 내 기록 히스토리 (닉네임 기준 최근 20개) */
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
        date: Utilities.formatDate(
          new Date(o.timestamp),
          Session.getScriptTimeZone(),
          "MM.dd HH:mm",
        ),
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

function sendResultEmail_(d) {
  var subject =
    "[StockBattle] 게임 결과 — " + d.symbolLabel + " / " + d.rank + "위";
  var body =
    d.nickname +
    " 님의 게임 결과\n\n" +
    "· 종목: " +
    d.symbolLabel +
    "\n" +
    "· 레버리지: " +
    d.leverage +
    "배\n" +
    "· 게임 시간: " +
    d.durationMin +
    "분\n" +
    "· 최종 수익률: " +
    d.finalReturn +
    "%\n" +
    "· 순위: " +
    d.rank +
    " / " +
    d.totalPlayers +
    "\n\n" +
    "※ 가상 머니를 사용한 교육·오락용 게임입니다. 실제 투자와 무관합니다.";
  MailApp.sendEmail(d.email, subject, body);
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

// ===== 최초 1회 실행 =====
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
    "EMAIL_STATUS",
  ]);
  sheet.getRange(1, 1, 1, 12).setFontWeight("bold");
  sheet.setFrozenRows(1);
  return sheet;
}

function createEmailTrigger() {
  // 중복 방지: 기존 동일 트리거 제거 후 재설치
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "processPendingEmails")
      ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("processPendingEmails")
    .timeBased()
    .everyMinutes(1)
    .create();
}
