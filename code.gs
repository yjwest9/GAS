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

// ===== Gemini (AI) =====
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
  players.appendRow(["roomId", "nick", "state", "finished", "updatedAt"]);
  players.getRange(1, 1, 1, 5).setFontWeight("bold");
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

// ===== AI: Gemini 호출 =====
function callGemini_(prompt, jsonMode, temp) {
  var key =
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) return null; // 키 없으면 클라이언트가 로컬 폴백 사용
  var url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL +
    ":generateContent";
  var gen = { temperature: temp == null ? 0.9 : temp, maxOutputTokens: 4096 };
  if (GEMINI_MODEL.indexOf("gemini-2.") === 0)
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
      }
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
    '님,"으로 시작.\n' +
    "규칙:\n" +
    "1) [사실] 거래내역·뉴스·결과에 실제로 적힌 것만 인용하라. 기록에 없는 행동(손절, 추가매수, 하지 않은 거래)이나 감정(당황·욕심 등)은 절대 지어내지 마라.\n" +
    "2) [해석] 사실을 나열만 하지 말고, 그 결정들이 결과(수익률·순위·청산 여부)로 어떻게 이어졌는지 가장 핵심적인 원인 1가지를 짚어라. 예: 레버리지 상향 타이밍, 뉴스 방향과 매매의 엇갈림, 종목 갈아타기, 손실 구간에서 포지션 유지.\n" +
    '3) [조언] 다음 판에 바로 적용할 구체적 개선점을 1가지만 제시하라. "힘내세요" 같은 추상적 격려 말고, 행동 단위로.\n' +
    "4) 3~4문장, 존댓말 평문, 마크다운(*, # 등) 금지. 담백하되 알맹이 있게.\n\n" +
    summary;
  return callGemini_(prompt, false, 0.5); // 사실 고정 + 해석 여지
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
function createRoom(opts) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rooms = ss.getSheetByName("Rooms");
  var players = ss.getSheetByName("Players");
  var roomId = genRoomCode_();
  var seed = Math.floor(Math.random() * 0x7fffffff);
  var news = aiRoomNews_(opts.category, opts.labels || []);
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
    0,
  ]);
  players.appendRow([roomId, opts.host || "방장", "", false, new Date()]);
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
      if (String(vals[r][1]) === String(nick)) return { error: "NICK_TAKEN" };
    }
  }
  if (count >= MAX_PLAYERS) return { error: "ROOM_FULL" };
  players.appendRow([roomId, nick, "", false, new Date()]);
  return roomBasic_(room);
}

// 방 나가기: 해당 플레이어 행 제거 (다시하기 안 누르고 홈으로/나가기 시 진짜 나감)
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
  return { ok: true };
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

function getRoomPlayers(roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var players = ss.getSheetByName("Players");
  var vals = players.getDataRange().getValues();
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
      };
    }
  }
  return Object.keys(map).map(function (k) {
    return {
      nick: map[k].nick,
      state: map[k].state,
      finished: map[k].finished,
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
