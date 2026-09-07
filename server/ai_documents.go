package main

// AI Documents: a PDF/DOCX/XLSX/PPTX/text file sent as a normal chat
// attachment gets extracted and summarized automatically, then can be
// asked follow-up questions against — all within the thread it was shared
// in. Uses the SAME "extraction is cheap and local, only the summary/answer
// touches the GPU" split as interview_cv.go's CV parsing, and directly
// reuses its extractText()/extractPDF()/extractDOCX() rather than
// duplicating them — this file only adds XLSX/PPTX, which that file never
// needed for a CV upload.
//
// Kept as its own file (not folded into ai.go) specifically to stay clear of
// concurrent work on ai.go/ai_meetings.go elsewhere in this tree.

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func migrateAIDocuments() {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS ai_documents (
		id VARCHAR(64) PRIMARY KEY,
		message_id VARCHAR(255) NOT NULL UNIQUE,
		thread_id VARCHAR(255) NOT NULL,
		file_name TEXT,
		extracted_text MEDIUMTEXT,
		summary TEXT,
		created_at DATETIME(6) DEFAULT NOW(6),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
		FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE)`)
	if err != nil {
		panic(err)
	}
}

// Roughly 3000 tokens of document text handed to the model per call — this
// model measures 15-30s+ per call even on short prompts (see
// gpu/AI_CONTRACT.md's Latency section), so a long document is deliberately
// truncated rather than chunked-and-summarized-recursively (which would mean
// several sequential slow calls per upload). Callers are told explicitly
// when this happened — see handleAIDocumentAsk's system prompt — rather than
// silently answering as if the whole document had been seen.
const maxDocChars = 12000

var pptxTextRe = regexp.MustCompile(`<a:t>([^<]*)</a:t>`)

// extractDocumentText dispatches by extension. PDF/DOCX/plain text go
// straight to interview_cv.go's extractText — identical problem, no reason
// to re-solve it. XLSX/PPTX are handled here since that file never needed
// them; both are, like DOCX, just a zip of XML under the hood.
func extractDocumentText(filename string, data []byte) (string, error) {
	lower := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lower, ".xlsx"):
		return extractXLSX(data)
	case strings.HasSuffix(lower, ".pptx"):
		return extractPPTX(data)
	default:
		return extractText(filename, data)
	}
}

// xlsxSharedStrings/xlsxWorksheet mirror just enough of the OOXML spreadsheet
// schema to resolve cells correctly. A naive regex pull of every <t> tag
// (tried first) is actively wrong for a real spreadsheet, not just
// low-fidelity: text cells store an INDEX into sharedStrings.xml, not their
// value inline, so a flat list of every <t> across both files interleaves
// header labels, cell text, and numbers with zero row/column association —
// confirmed by testing against a real 3-row budget sheet, which came back as
// "Category Engineering with Amount Fatima Al-Sayed" (a real name landed in
// the Amount field, and the actual numbers vanished, since numbers live in
// <v> with no <t> at all). Walking rows/cells properly and resolving shared-
// string indices is what makes the output a real table instead of word soup.
type xlsxSharedStrings struct {
	SI []struct {
		T string `xml:"t"`
		R []struct {
			T string `xml:"t"`
		} `xml:"r"` // rich-text runs: <si><r><t>...</t></r>...</si>, no single top-level <t>
	} `xml:"si"`
}

type xlsxWorksheet struct {
	SheetData struct {
		Row []struct {
			C []struct {
				Type string `xml:"t,attr"` // "s"=shared string, "str"/"inlineStr"=literal string, "" = number/blank
				V    string `xml:"v"`
				Is   struct {
					T string `xml:"t"`
				} `xml:"is"`
			} `xml:"c"`
		} `xml:"row"`
	} `xml:"sheetData"`
}

func readZipFile(zr *zip.Reader, name string) ([]byte, bool) {
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, false
		}
		defer rc.Close()
		raw, err := io.ReadAll(io.LimitReader(rc, 20*1024*1024))
		if err != nil {
			return nil, false
		}
		return raw, true
	}
	return nil, false
}

// extractXLSX resolves every cell to its real display value (shared string,
// inline string, or number) and emits one line of pipe-separated values per
// row — a table dump good enough for the model to reason about correctly,
// not a faithful spreadsheet reconstruction (formulas are shown as their
// last-computed value, formatting is not preserved).
func extractXLSX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("could not read the XLSX file")
	}

	var shared []string
	if raw, ok := readZipFile(zr, "xl/sharedStrings.xml"); ok {
		var sst xlsxSharedStrings
		if xml.Unmarshal(raw, &sst) == nil {
			for _, si := range sst.SI {
				if si.T != "" {
					shared = append(shared, si.T)
					continue
				}
				var runs strings.Builder
				for _, r := range si.R {
					runs.WriteString(r.T)
				}
				shared = append(shared, runs.String())
			}
		}
	}

	var sheetNames []string
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml") {
			sheetNames = append(sheetNames, f.Name)
		}
	}
	sort.Strings(sheetNames)

	var sb strings.Builder
	found := false
	for _, name := range sheetNames {
		raw, ok := readZipFile(zr, name)
		if !ok {
			continue
		}
		var ws xlsxWorksheet
		if xml.Unmarshal(raw, &ws) != nil {
			continue
		}
		if len(sheetNames) > 1 {
			fmt.Fprintf(&sb, "--- %s ---\n", name)
		}
		for _, row := range ws.SheetData.Row {
			var cells []string
			for _, c := range row.C {
				var val string
				switch c.Type {
				case "s":
					if idx, err := strconv.Atoi(strings.TrimSpace(c.V)); err == nil && idx >= 0 && idx < len(shared) {
						val = shared[idx]
					}
				case "str", "inlineStr":
					if c.Is.T != "" {
						val = c.Is.T
					} else {
						val = c.V
					}
				default:
					val = c.V // number, or blank
				}
				if val != "" {
					cells = append(cells, val)
					found = true
				}
			}
			if len(cells) > 0 {
				sb.WriteString(strings.Join(cells, " | "))
				sb.WriteString("\n")
			}
		}
	}
	if !found {
		return "", fmt.Errorf("no readable text found in the XLSX file")
	}
	return sb.String(), nil
}

// extractPPTX pulls the text runs (<a:t>) out of every ppt/slides/slideN.xml,
// one slide at a time. Slides are sorted by filename so a 10+ slide deck
// still comes out in the right order (zip file order is not numeric, and a
// naive string sort alone would put "slide10" before "slide2").
func extractPPTX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("could not read the PPTX file")
	}
	var slideFiles []*zip.File
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "ppt/slides/slide") && strings.HasSuffix(f.Name, ".xml") {
			slideFiles = append(slideFiles, f)
		}
	}
	sort.Slice(slideFiles, func(i, j int) bool {
		return slideNumber(slideFiles[i].Name) < slideNumber(slideFiles[j].Name)
	})

	var sb strings.Builder
	found := false
	for _, f := range slideFiles {
		rc, err := f.Open()
		if err != nil {
			continue
		}
		raw, err := io.ReadAll(io.LimitReader(rc, 20*1024*1024))
		rc.Close()
		if err != nil {
			continue
		}
		sb.WriteString("--- slide ---\n")
		for _, m := range pptxTextRe.FindAllSubmatch(raw, -1) {
			sb.Write(m[1])
			sb.WriteString("\n")
			found = true
		}
	}
	if !found {
		return "", fmt.Errorf("no readable text found in the PPTX file")
	}
	return sb.String(), nil
}

var slideNumRe = regexp.MustCompile(`slide(\d+)\.xml$`)

func slideNumber(name string) int {
	m := slideNumRe.FindStringSubmatch(name)
	if len(m) != 2 {
		return 0
	}
	n := 0
	for _, c := range m[1] {
		n = n*10 + int(c-'0')
	}
	return n
}

// ─── POST /api/ai/documents/extract ──────────────────────────────────────────
// Called by the client right after sending a document attachment. Extraction
// itself is cheap/local and always attempted; the summary is best-effort —
// if the GPU call fails or times out, the extracted text is still stored so
// handleAIDocumentAsk can work even without a successful initial summary.

func handleAIDocumentExtract(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	var req struct {
		MessageID string `json:"messageId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MessageID == "" {
		fail(w, "messageId is required", 400)
		return
	}

	var threadID, fileName, fileData string
	err = db.QueryRow(`SELECT thread_id, COALESCE(file_name,''), COALESCE(file_data,'') FROM messages WHERE id=?`, req.MessageID).
		Scan(&threadID, &fileName, &fileData)
	if err != nil {
		fail(w, "message not found", 404)
		return
	}
	if !isMember(threadID, uid) {
		fail(w, "not a member", 403)
		return
	}
	if fileData == "" {
		fail(w, "that message has no file attached", 400)
		return
	}

	// file_data is a data: URL (see handleFileAttach on the client) — strip
	// the "data:<mime>;base64," prefix before decoding.
	b64 := fileData
	if idx := strings.Index(b64, ","); idx != -1 && strings.Contains(b64[:idx], "base64") {
		b64 = b64[idx+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		fail(w, "could not decode the attached file", 400)
		return
	}

	text, err := extractDocumentText(fileName, raw)
	if err != nil {
		fail(w, err.Error(), 422)
		return
	}

	var summary string
	if aiGPUConfigured() {
		truncated := text
		if len(truncated) > maxDocChars {
			truncated = truncated[:maxDocChars]
		}
		system := "You summarize documents. Read the document text below and write a concise 3-5 sentence " +
			"summary of what it actually contains. Be factual — only summarize what is present, never invent " +
			"content. Reply with ONLY the summary, no preamble, no markdown."
		prompt := fmt.Sprintf("Document (%s):\n\n%s", fileName, truncated)
		if result, aerr := aiChat(r.Context(), system, nil, prompt, nil); aerr == nil {
			summary = result
		}
		// A failed/timed-out summary is not a failed extraction — the text is
		// stored either way below, and handleAIDocumentAsk works off it
		// regardless of whether this particular call succeeded.
	}

	_, err = db.Exec(`INSERT INTO ai_documents(id, message_id, thread_id, file_name, extracted_text, summary)
		VALUES (?,?,?,?,?,?)
		ON DUPLICATE KEY UPDATE extracted_text=VALUES(extracted_text), summary=VALUES(summary)`,
		newID(), req.MessageID, threadID, fileName, text, summary)
	if err != nil {
		fail(w, "db error", 500)
		return
	}

	ok(w, map[string]any{"summary": summary, "textLength": len(text)})
}

// ─── POST /api/ai/documents/ask ──────────────────────────────────────────────

func handleAIDocumentAsk(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	if !aiGPUConfigured() {
		fail(w, ErrAIGPUNotConfigured.Error(), 503)
		return
	}
	var req struct {
		MessageID string `json:"messageId"`
		Question  string `json:"question"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MessageID == "" || req.Question == "" {
		fail(w, "messageId and question are required", 400)
		return
	}

	var threadID, fileName, text string
	err = db.QueryRow(`SELECT thread_id, COALESCE(file_name,''), extracted_text FROM ai_documents WHERE message_id=?`, req.MessageID).
		Scan(&threadID, &fileName, &text)
	if err != nil {
		fail(w, "that document hasn't been processed yet", 404)
		return
	}
	if !isMember(threadID, uid) {
		fail(w, "not a member", 403)
		return
	}

	truncated := text
	wasTruncated := false
	if len(truncated) > maxDocChars {
		truncated = truncated[:maxDocChars]
		wasTruncated = true
	}
	system := "You answer questions about a specific document, using ONLY the document text provided below. " +
		"If the answer is not in the text, say so clearly rather than guessing. Reply with ONLY the answer, no preamble."
	if wasTruncated {
		system += " Note: only the beginning of this document was available to you — if the question is about " +
			"content that might be further in, say you cannot see that part rather than guessing."
	}
	prompt := fmt.Sprintf("Document (%s):\n\n%s\n\nQuestion: %s", fileName, truncated, req.Question)

	result, err := aiChat(r.Context(), system, nil, prompt, nil)
	if err != nil {
		fail(w, err.Error(), 502)
		return
	}
	ok(w, map[string]string{"result": result})
}
