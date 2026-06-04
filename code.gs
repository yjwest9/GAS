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
const MAX_PLAYERS = 8; // 방 정원 (서버 안정성: Sheets 폴링 부하 고려)

// ===== Gemini (AI) =====
// 키는 코드에 넣지 않고 스크립트 속성(GEMINI_API_KEY)에서 읽음.
// 프로젝트 설정 > 스크립트 속성 > 속성 GEMINI_API_KEY / 값 AIza... 로 저장.
const GEMINI_MODEL = "gemini-2.5-flash";

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
// items: [{category, symbol}, ...]  ->  [{symbol, price}, ...]
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
    payload.feedback || "",
    payload.detail || "",
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
        id: o.id,
        date: Utilities.formatDate(
          new Date(o.timestamp),
          Session.getScriptTimeZone(),
          "MM.dd HH:mm",
        ),
        mode: o.mode,
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
    "\n" +
    (d.feedback ? "\n🤖 AI 분석: " + d.feedback + "\n" : "") +
    "\n※ 가상 머니를 사용한 교육·오락용 게임입니다. 실제 투자와 무관합니다.";
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
    "feedback",
    "detail",
    "EMAIL_STATUS",
  ]);
  sheet.getRange(1, 1, 1, 14).setFontWeight("bold");
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
  ]);
  rooms.getRange(1, 1, 1, 10).setFontWeight("bold");
  rooms.setFrozenRows(1);

  var players = ss.getSheetByName("Players") || ss.insertSheet("Players");
  players.clear();
  players.appendRow(["roomId", "nick", "ret", "finished", "updatedAt"]);
  players.getRange(1, 1, 1, 5).setFontWeight("bold");
  players.setFrozenRows(1);

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

// ===== AI: Gemini 호출 =====
// 키가 없으면 null 반환 → 클라이언트가 로컬 폴백 사용
function callGemini_(prompt, jsonMode) {
  var key =
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) return null; // 키 없으면 클라이언트가 로컬 폴백 사용
  var url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL +
    ":generateContent";
  var gen = { temperature: 0.9, maxOutputTokens: 4096 };
  if (GEMINI_MODEL.indexOf("gemini-2.") === 0)
    gen.thinkingConfig = { thinkingBudget: 0 }; // 2.x: 사고 끔 → 빠르고 답이 안 비게
  if (jsonMode) gen.responseMimeType = "application/json";
  var opt = {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": key }, // 키는 헤더로 (URL 노출 방지)
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
      } // 쿼터/일시 오류 → 재시도
      var data = JSON.parse(res.getContentText());
      var cand = data.candidates && data.candidates[0];
      if (cand && cand.content && cand.content.parts) {
        var txt = cand.content.parts
          .map(function (p) {
            return p.text || "";
          })
          .join("")
          .trim();
        if (txt) return txt;
      }
      return null;
    } catch (e) {
      Utilities.sleep(800);
    }
  }
  return null;
}

// 시작 시: 시황 브리핑 + 종목별 속보 헤드라인 생성
// items: [{label, dir}]  (dir 1=호재, -1=악재)  ->  {brief, heads:[...]} | null
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

// 종료 시: 거래 기록 기반 피드백 (지어내지 말고 기록만 근거)
function aiFeedback(summary, nickname) {
  var who = nickname || "플레이어";
  var prompt =
    "너는 트레이딩 코치다. 아래는 가상 주식 게임 한 판의 플레이어 거래 기록과 결과다.\n" +
    '맨 처음에 "' +
    who +
    '님,"으로 부르며 시작해라.\n' +
    "기록에 있는 행동만 근거로, 잘한 점과 아쉬운 점을 합쳐 3~4문장으로 간결하게 평가해라.\n" +
    "기록에 없는 내용은 절대 지어내지 마라. 친근한 존댓말 톤. 마크다운 기호(*, #, 굵게 등) 쓰지 말고 평문으로.\n\n" +
    summary;
  return callGemini_(prompt, false); // 문자열 or null
}

// ===================== 멀티플레이 (Step A: 서버 토대) =====================
// 동기화 전략: 가격/뉴스/봇은 시드로 전원 동일하게 계산(클라이언트). 서버는 방 메타와
// 각 플레이어의 수익률 한 줄만 주고받음 → Sheets 부담 최소화.

function genRoomCode_() {
  var c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    s = "";
  for (var i = 0; i < 5; i++)
    s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}

// 방 생성. opts: {category, leverage, durationMin, host, labels:[종목명...]}
function createRoom(opts) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rooms = ss.getSheetByName("Rooms");
  var players = ss.getSheetByName("Players");
  var roomId = genRoomCode_();
  var seed = Math.floor(Math.random() * 0x7fffffff);
  var news = aiRoomNews_(opts.category, opts.labels || []); // {종목:{pos,neg}} (키 없으면 {})
  rooms.appendRow([
    roomId,
    seed,
    opts.category,
    opts.leverage,
    opts.durationMin,
    "waiting",
    "",
    JSON.stringify(news || {}),
    opts.host || "방장",
    new Date(),
  ]);
  players.appendRow([roomId, opts.host || "방장", 0, false, new Date()]);
  var url = "";
  try {
    url = ScriptApp.getService().getUrl() + "?room=" + roomId;
  } catch (e) {}
  return { roomId: roomId, inviteUrl: url };
}

// 입장
function joinRoom(roomId, nick) {
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
      if (String(vals[r][1]) === String(nick)) return { error: "NICK_TAKEN" }; // 같은 방 닉 중복 금지
    }
  }
  if (count >= MAX_PLAYERS) return { error: "ROOM_FULL" };
  players.appendRow([roomId, nick, 0, false, new Date()]);
  return roomBasic_(room);
}

// 대기실/게임 상태 조회 (폴링용)
function getLobby(roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var room = findRoom_(ss, roomId);
  if (!room) return { error: "NOT_FOUND" };
  return {
    status: room.status,
    startTime: room.startTime ? new Date(room.startTime).getTime() : 0,
    host: room.host,
    category: room.category,
    leverage: room.leverage,
    durationMin: room.durationMin,
    seed: Number(room.seed),
    news: room.news ? JSON.parse(room.news) : {},
    inviteUrl: inviteUrl_(roomId),
    serverNow: Date.now(),
    players: getRoomPlayers(roomId),
  };
}

// 게임 시작 (방장) → 4초 뒤 동시 시작 시각 설정
function startRoom(roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rooms = ss.getSheetByName("Rooms");
  var vals = rooms.getDataRange().getValues();
  var h = vals[0];
  var sc = h.indexOf("status"),
    tc = h.indexOf("startTime"),
    ic = h.indexOf("roomId");
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][ic]) === String(roomId)) {
      var st = new Date(Date.now() + 6000);
      rooms.getRange(r + 1, sc + 1).setValue("playing");
      rooms.getRange(r + 1, tc + 1).setValue(st);
      return { startTime: st.getTime() };
    }
  }
  return { error: "NOT_FOUND" };
}

// 내 수익률 갱신 + 전체 순위 반환 (게임 중 폴링)
function updatePlayer(roomId, nick, ret, finished) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {
    if (
      String(vals[r][0]) === String(roomId) &&
      String(vals[r][1]) === String(nick)
    ) {
      players.getRange(r + 1, 3, 1, 3).setValues([[ret, finished, new Date()]]);
      break;
    }
  }
  return getRoomPlayers(roomId);
}

function getRoomPlayers(roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
  var map = {}; // nick -> {nick, ret, finished, t}  (혹시 모를 중복 행은 최신 것만)
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) !== String(roomId)) continue;
    var nick = String(vals[r][1]);
    var t = vals[r][4] ? new Date(vals[r][4]).getTime() : 0;
    if (!map[nick] || t >= map[nick].t) {
      map[nick] = {
        nick: nick,
        ret: Number(vals[r][2]),
        finished: vals[r][3] === true || vals[r][3] === "true",
        t: t,
      };
    }
  }
  var out = Object.keys(map).map(function (k) {
    return { nick: map[k].nick, ret: map[k].ret, finished: map[k].finished };
  });
  out.sort(function (a, b) {
    return b.ret - a.ret;
  });
  return out;
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

// 방 전용 AI 뉴스 템플릿 (종목별 호재/악재 1개씩) — 1회 생성해 전원이 시드로 동일하게 사용
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
