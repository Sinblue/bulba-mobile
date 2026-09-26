# 妙蛙收藏查詢（手機第 0～1 階段）

離線、唯讀的收藏查詢網頁。**這個資料夾只有程式，沒有收藏資料**；資料由電腦匯出後，在手機上匯入，
只存在該手機的瀏覽器（IndexedDB）。完整流程、搜尋規則、卡圖比對與實機測試方式見主專案的 `MOBILE_FLOW.md`。

拍照卡圖比對使用 [OpenCV.js](https://opencv.org/) 4.13.0（`vendor/opencv.js`，Apache License 2.0，授權全文見 `vendor/opencv-LICENSE.txt`）。

## 部署到 GitHub Pages

> 主專案 repo **不可公開**：`mapping/migration.json` 含購入價等個人資料。只把 `mobile/` 的內容放到另一個 repo。

1. 在 GitHub 建一個新 repo（例 `bulba-mobile`），只放這個資料夾的內容（`index.html` 等檔案位於 repo 根目錄）。
2. repo 的 Settings → Pages → Source 選 `main` 分支的 `/ (root)`，儲存後取得 `https://<帳號>.github.io/bulba-mobile/`。
3. 手機用 Chrome 開該網址，選單「加到主畫面」。
4. 開啟後按「匯入資料」，選電腦匯出的 `bulba_mobile_….json`。之後沒有網路也能查詢。

## 更新

- **更新資料**：電腦收藏目錄按「匯出手機資料」→ 傳到手機 → 在頁面按「匯入資料」。舊資料會保留一份，可「還原上一份」。
- **更新程式**：把本資料夾內容複製到 Pages repo 並 push；**一定要把 `sw.js` 的 `CACHE` 版本號加一**，
  否則手機會繼續用快取的舊版。手機連網開啟一次後，再重新整理即為新版。
