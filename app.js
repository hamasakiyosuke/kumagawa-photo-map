// ==============================
// あなたが埋めるのはこの2つだけ
// ==============================
const OAUTH_CLIENT_ID_B = "797038857105-r97jfoepatc3pcj3hialai0qm7crg5b4.apps.googleusercontent.com";  // 例: xxxx.apps.googleusercontent.com
const ROOT_FOLDER_ID = "1OzL9Zk761DIThXxuR_dHo2aF7JFJhDRV"; // ルート（大フォルダ）のID

// Drive API 用（gapi初期化）
// ※ いまは簡略化で Maps の APIキーと同じものを入れてOK（ただし本番はDrive用キー分離推奨）
const DRIVE_API_KEY_FOR_GAPI = "AIzaSyASdDNTrxCsqkw9W9vG3WnwZvRkbiyHTRc";

// Drive API の権限（閲覧のみ）
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";
const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";

let tokenClient;
let gapiInited = false;
let gisInited = false;

let map;
let markers = [];
let noGpsItems = [];

const KUMAGAWA_CENTER = { lat: 32.22, lng: 130.75 };

window.initMap = () => {
  map = new google.maps.Map(document.getElementById("map"), {
    center: KUMAGAWA_CENTER,
    zoom: 9,
  });
};

function setButtons() {
  const signinBtn = document.getElementById("signin");
  const loadBtn = document.getElementById("load");
  signinBtn.disabled = !(gapiInited && gisInited);
  loadBtn.disabled = true;
}

function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function renderNoGps() {
  const el = document.getElementById("nogpsList");
  if (noGpsItems.length === 0) {
    el.textContent = "ありません";
    return;
  }
  el.innerHTML = noGpsItems
    .map(x => `・${escapeHtml(x.sensorName)}（${escapeHtml(x.riverName)}）`)
    .join("<br>");
}

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ------------------------------
// Google API 初期化
// ------------------------------
gapi.load("client", async () => {
  await gapi.client.init({
    apiKey: DRIVE_API_KEY_FOR_GAPI,
    discoveryDocs: [DISCOVERY_DOC],
  });
  gapiInited = true;
  setButtons();
});

window.onload = () => {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID_B,
    scope: SCOPES,
    callback: "",
  });
  gisInited = true;
  setButtons();

  document.getElementById("signin").onclick = handleAuthClick;
  document.getElementById("load").onclick = loadAndPlotFromRoot;
};

async function handleAuthClick() {
  tokenClient.callback = async (resp) => {
    if (resp.error) {
      alert("ログインでエラーが出ました。もう一度お試しください。");
      console.error(resp);
      return;
    }
    document.getElementById("load").disabled = false;
    alert("ログインOK！次に「② フォルダを読み込み」を押してください。");
  };

  tokenClient.requestAccessToken({ prompt: "consent" });
}

// ------------------------------
// Drive 便利関数
// ------------------------------
async function listFolders(parentId) {
  // フォルダだけを列挙
  const files = await listAllFiles(
    `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    "files(id,name,webViewLink)"
  );
  return files;
}

async function listImages(parentId) {
  // 画像だけを列挙（GPS取得用にimageMediaMetadata）
  const files = await listAllFiles(
    `'${parentId}' in parents and mimeType contains 'image/' and trashed = false`,
    "files(id,name,createdTime,imageMediaMetadata,thumbnailLink,webViewLink)"
  );
  return files;
}

async function listAllFiles(q, fieldsFilesPart) {
  // ページング対応で全件取得
  let all = [];
  let pageToken = undefined;

  while (true) {
    const res = await gapi.client.drive.files.list({
      q,
      pageSize: 200,
      fields: `nextPageToken,${fieldsFilesPart}`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });

    const batch = res.result.files ?? [];
    all = all.concat(batch);

    pageToken = res.result.nextPageToken;
    if (!pageToken) break;
  }

  return all;
}

// ------------------------------
// ルート→川→センサー→写真 を辿って、センサーごとに1本ピン
// ------------------------------
async function loadAndPlotFromRoot() {
  if (!map) {
    alert("地図の読み込みがまだのようです。少し待ってからもう一度押してください。");
    return;
  }

  clearMarkers();
  noGpsItems = [];
  renderNoGps();

  alert("読み込みを開始します（フォルダ数が多いと少し時間がかかります）");

  // 1) ルート直下：川フォルダ
  const riverFolders = await listFolders(ROOT_FOLDER_ID);
  if (riverFolders.length === 0) {
    alert("ルートフォルダ直下にフォルダ（川名）が見つかりませんでした。フォルダIDが合っているか確認してください。");
    return;
  }

  let plotted = 0;

  // 2) 川ごとに、センサー番号フォルダを列挙
  for (const river of riverFolders) {
    const sensorFolders = await listFolders(river.id);

    for (const sensor of sensorFolders) {
      // 3) センサー番号フォルダ内の写真を列挙
      const images = await listImages(sensor.id);

      // GPS付きの写真を1枚探す（最初に見つかったもの）
      const hit = images.find(img => {
        const loc = img.imageMediaMetadata?.location;
        return typeof loc?.latitude === "number" && typeof loc?.longitude === "number";
      });

      if (!hit) {
        noGpsItems.push({ riverName: river.name, sensorName: sensor.name });
        continue;
      }

      const lat = hit.imageMediaMetadata.location.latitude;
      const lng = hit.imageMediaMetadata.location.longitude;

      plotted++;

      const marker = new google.maps.Marker({
        position: { lat, lng },
        map,
        title: `${river.name} / ${sensor.name}`,
      });

      const dateText = hit.createdTime ? new Date(hit.createdTime).toLocaleString("ja-JP") : "日時不明";
      const thumb = hit.thumbnailLink
        ? `<img src="${hit.thumbnailLink}" style="max-width:240px;border-radius:8px" />`
        : `<div class="small">（プレビューなし）</div>`;

      // フォルダに飛べるリンク（webViewLink）
      const folderLink = sensor.webViewLink
        ? `<a href="${sensor.webViewLink}" target="_blank" rel="noopener">📂 このセンサー番号フォルダを開く</a>`
        : `<span class="small">（フォルダリンク取得不可）</span>`;

      const info = new google.maps.InfoWindow({
        content: `
          <div style="max-width:280px">
            <div><b>${escapeHtml(river.name)} / ${escapeHtml(sensor.name)}</b></div>
            <div class="small">写真: ${escapeHtml(hit.name)} / ${escapeHtml(dateText)}</div>
            <div style="margin-top:6px">${thumb}</div>
            <div style="margin-top:8px">${folderLink}</div>
          </div>
        `,
      });

      marker.addListener("click", () => info.open({ anchor: marker, map }));
      markers.push(marker);
    }
  }

  renderNoGps();

  if (plotted > 0) {
    alert(`完了：センサー番号フォルダ単位で ${plotted} 本のピンを表示しました！`);
    map.setCenter(KUMAGAWA_CENTER);
    map.setZoom(9);
  } else {
    alert("GPS付きの写真が見つかりませんでした。「GPSなし写真」を確認してください。");
  }
}
