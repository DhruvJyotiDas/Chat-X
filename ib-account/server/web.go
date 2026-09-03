package main

import (
	_ "embed"
	"net/http"
	"strings"
)

//go:embed web/index.html
var indexHTML []byte

// serveApp returns the single-page sign-in / account UI. Client-side routing is
// driven by the query string (?screen=…) and by any OAuth params already on the
// URL, so every non-API GET under the base path resolves here.
func (a *App) serveApp(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	body := strings.ReplaceAll(string(indexHTML), "__BASE_PATH__", a.cfg.BasePath)
	w.Write([]byte(body))
}
