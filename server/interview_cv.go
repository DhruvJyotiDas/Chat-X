package main

// CV ingestion: turn an uploaded file into structured profile data.
//
// Runs entirely on THIS VM — no GPU involved. That is deliberate: parsing is
// cheap, deterministic and testable, and pushing it to the model would make a
// simple job slow, expensive and non-reproducible.
//
// Formats: PDF (pure-Go extractor, no external binaries — there is no
// `pdftotext` on this host), DOCX (stdlib zip + xml), and plain text/markdown.

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/ledongthuc/pdf"
)

type SocialLink struct {
	Platform string `json:"platform"`
	URL      string `json:"url"`
	Handle   string `json:"handle,omitempty"`
}

type ParsedCV struct {
	FullName   string       `json:"fullName,omitempty"`
	Email      string       `json:"email,omitempty"`
	Phone      string       `json:"phone,omitempty"`
	Headline   string       `json:"headline,omitempty"`
	Location   string       `json:"location,omitempty"`
	Summary    string       `json:"summary,omitempty"`
	Skills     []string     `json:"skills"`
	Links      []SocialLink `json:"links"`
	TextLength int          `json:"textLength"`
}

// ─── Text extraction ─────────────────────────────────────────────────────────

func extractText(filename string, data []byte) (string, error) {
	lower := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lower, ".pdf"), bytes.HasPrefix(data, []byte("%PDF")):
		return extractPDF(data)
	case strings.HasSuffix(lower, ".docx"), bytes.HasPrefix(data, []byte("PK\x03\x04")):
		return extractDOCX(data)
	case strings.HasSuffix(lower, ".txt"), strings.HasSuffix(lower, ".md"),
		strings.HasSuffix(lower, ".rtf"):
		return string(data), nil
	default:
		// Sniff: if it decodes as mostly-printable text, take it.
		if isMostlyText(data) {
			return string(data), nil
		}
		return "", fmt.Errorf("unsupported file type — upload a PDF, DOCX, or plain text CV")
	}
}

func isMostlyText(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	n := len(b)
	if n > 4096 {
		n = 4096
	}
	printable := 0
	for _, c := range b[:n] {
		if c == '\n' || c == '\r' || c == '\t' || (c >= 0x20 && c < 0x7f) || c >= 0xc0 {
			printable++
		}
	}
	return float64(printable)/float64(n) > 0.85
}

func extractPDF(data []byte) (string, error) {
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("could not read the PDF — it may be encrypted or damaged")
	}
	var sb strings.Builder
	for i := 1; i <= r.NumPage(); i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		// GetPlainText can panic on malformed content streams; a bad CV should
		// produce an error message, not take the backend down.
		func() {
			defer func() { _ = recover() }()
			if txt, err := p.GetPlainText(nil); err == nil {
				sb.WriteString(txt)
				sb.WriteString("\n")
			}
		}()
	}
	out := sb.String()
	if strings.TrimSpace(out) == "" {
		return "", fmt.Errorf("no text found in the PDF — if it is a scan, upload a text-based CV instead")
	}
	return out, nil
}

// extractDOCX reads word/document.xml straight out of the zip. A .docx is just a
// zip of XML, so this needs no third-party dependency at all.
func extractDOCX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("could not read the DOCX file")
	}
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", fmt.Errorf("could not open the document body")
		}
		defer rc.Close()
		raw, err := io.ReadAll(io.LimitReader(rc, 20*1024*1024))
		if err != nil {
			return "", fmt.Errorf("could not read the document body")
		}
		return docxXMLToText(raw), nil
	}
	return "", fmt.Errorf("that DOCX has no readable document body")
}

// docxXMLToText walks the XML keeping <w:t> runs and turning paragraph and break
// elements into newlines, so layout survives well enough for section detection.
func docxXMLToText(raw []byte) string {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var sb strings.Builder
	inText := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				inText = true
			case "p", "br", "tab":
				sb.WriteString("\n")
			}
		case xml.EndElement:
			if t.Name.Local == "t" {
				inText = false
			}
		case xml.CharData:
			if inText {
				sb.Write(t)
			}
		}
	}
	return sb.String()
}

// ─── Structured extraction ───────────────────────────────────────────────────

var (
	reEmail = regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`)
	rePhone = regexp.MustCompile(`(?:\+\d{1,3}[\s\-.]?)?(?:\(\d{2,4}\)[\s\-.]?)?\d{3,5}[\s\-.]?\d{3,5}(?:[\s\-.]?\d{2,4})?`)
	reURL   = regexp.MustCompile(`(?i)\b(?:https?://)?(?:www\.)?([a-z0-9\-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)(/[^\s,;)\]]*)?`)
)

// Platform detection. LinkedIn is recognised and surfaced as a link but NEVER
// fetched: there is no public API, logged-out profile requests are actively
// blocked, and scraping violates their terms. GitHub is the one that can
// genuinely be enriched — see interview_github.go.
var platformHosts = []struct {
	match    string
	platform string
}{
	{"linkedin.com", "linkedin"},
	{"github.com", "github"},
	{"gitlab.com", "gitlab"},
	{"stackoverflow.com", "stackoverflow"},
	{"leetcode.com", "leetcode"},
	{"kaggle.com", "kaggle"},
	{"medium.com", "medium"},
	{"dev.to", "devto"},
	{"behance.net", "behance"},
	{"dribbble.com", "dribbble"},
	{"twitter.com", "twitter"},
	{"x.com", "twitter"},
	{"youtube.com", "youtube"},
}

// A pragmatic skill list. Deliberately explicit rather than model-driven: it is
// instant, free, reproducible, and good enough to seed question generation —
// the model gets the full CV text anyway and can infer beyond this.
var knownSkills = []string{
	"Go", "Golang", "Python", "JavaScript", "TypeScript", "Java", "Kotlin", "Swift",
	"C++", "C#", "Rust", "Ruby", "PHP", "Scala", "R", "MATLAB", "Dart",
	"React", "Next.js", "Vue", "Angular", "Svelte", "Node.js", "Express", "Django",
	"Flask", "FastAPI", "Spring", "Rails", "Laravel", ".NET",
	"PostgreSQL", "MySQL", "MariaDB", "MongoDB", "Redis", "SQLite", "Elasticsearch",
	"Cassandra", "DynamoDB", "Kafka", "RabbitMQ", "GraphQL", "REST", "gRPC",
	"Docker", "Kubernetes", "Terraform", "Ansible", "Jenkins", "GitHub Actions",
	"AWS", "GCP", "Azure", "Linux", "Nginx", "CI/CD", "Git",
	"TensorFlow", "PyTorch", "scikit-learn", "Pandas", "NumPy", "OpenCV", "LLM",
	"Machine Learning", "Deep Learning", "NLP", "Computer Vision", "Data Science",
	"HTML", "CSS", "Tailwind", "SASS", "Figma", "WebRTC", "WebSocket",
	"Agile", "Scrum", "Microservices", "System Design", "Testing", "TDD",
}

func parseCV(text string) ParsedCV {
	out := ParsedCV{TextLength: len(text), Skills: []string{}, Links: []SocialLink{}}
	lines := strings.Split(text, "\n")

	if m := reEmail.FindString(text); m != "" {
		out.Email = m
	}
	out.Phone = findPhone(text)
	out.FullName = guessName(lines, out.Email)
	out.Headline = guessHeadline(lines, out.FullName)
	out.Location = guessLocation(text)
	out.Summary = guessSummary(lines)
	out.Skills = findSkills(text)
	out.Links = findLinks(text)
	return out
}

func findPhone(text string) string {
	// Restrict to lines that look like contact details, otherwise dates and
	// numeric results in the body get matched as phone numbers.
	for _, line := range strings.Split(text, "\n") {
		l := strings.ToLower(line)
		if !strings.Contains(l, "phone") && !strings.Contains(l, "mobile") &&
			!strings.Contains(l, "tel") && !strings.Contains(line, "+") {
			continue
		}
		for _, cand := range rePhone.FindAllString(line, -1) {
			digits := 0
			for _, c := range cand {
				if c >= '0' && c <= '9' {
					digits++
				}
			}
			if digits >= 8 && digits <= 15 {
				return strings.TrimSpace(cand)
			}
		}
	}
	return ""
}

// guessName: CVs almost universally lead with the candidate's name.
func guessName(lines []string, email string) string {
	for i, raw := range lines {
		if i > 12 {
			break
		}
		l := strings.TrimSpace(raw)
		if l == "" || len(l) > 48 || strings.ContainsAny(l, "@|·•/\\") {
			continue
		}
		if reURL.MatchString(l) || strings.ContainsAny(l, "0123456789") {
			continue
		}
		words := strings.Fields(l)
		if len(words) < 2 || len(words) > 5 {
			continue
		}
		caps := 0
		for _, w := range words {
			r := []rune(w)
			if len(r) > 0 && r[0] >= 'A' && r[0] <= 'Z' {
				caps++
			}
		}
		if caps >= len(words)-1 {
			return l
		}
	}
	// Fall back to the local part of the email — better than nothing.
	if email != "" {
		local := strings.SplitN(email, "@", 2)[0]
		local = strings.NewReplacer(".", " ", "_", " ", "-", " ").Replace(local)
		return strings.TrimSpace(strings.Title(local)) //nolint:staticcheck
	}
	return ""
}

func guessHeadline(lines []string, name string) string {
	seenName := name == ""
	for i, raw := range lines {
		if i > 14 {
			break
		}
		l := strings.TrimSpace(raw)
		if l == "" {
			continue
		}
		if !seenName {
			if strings.EqualFold(l, name) {
				seenName = true
			}
			continue
		}
		if reEmail.MatchString(l) || reURL.MatchString(l) || len(l) > 90 || len(l) < 6 {
			continue
		}
		return l
	}
	return ""
}

var locationHints = regexp.MustCompile(`(?i)\b(bangalore|bengaluru|mumbai|delhi|hyderabad|chennai|pune|kolkata|noida|gurgaon|jaipur|ahmedabad|india|london|new york|san francisco|berlin|singapore|dubai|toronto|sydney|remote)\b`)

func guessLocation(text string) string {
	head := text
	if len(head) > 1500 {
		head = head[:1500]
	}
	if m := locationHints.FindString(head); m != "" {
		return strings.Title(strings.ToLower(m)) //nolint:staticcheck
	}
	return ""
}

var summaryHeads = regexp.MustCompile(`(?i)^\s*(summary|profile|objective|about( me)?)\s*:?\s*$`)

func guessSummary(lines []string) string {
	for i, l := range lines {
		if !summaryHeads.MatchString(l) {
			continue
		}
		var parts []string
		for j := i + 1; j < len(lines) && j < i+8; j++ {
			t := strings.TrimSpace(lines[j])
			if t == "" {
				if len(parts) > 0 {
					break
				}
				continue
			}
			// Stop at the next section heading.
			if len(t) < 30 && t == strings.ToUpper(t) && len(strings.Fields(t)) <= 3 {
				break
			}
			parts = append(parts, t)
		}
		if s := strings.Join(parts, " "); len(s) > 20 {
			if len(s) > 600 {
				s = s[:600] + "…"
			}
			return s
		}
	}
	return ""
}

func findSkills(text string) []string {
	lower := strings.ToLower(text)
	seen := map[string]bool{}
	var out []string
	for _, s := range knownSkills {
		ls := strings.ToLower(s)
		// Check EVERY occurrence, not just the first. A skill often appears in
		// prose before the skills section ("…in Go and TypeScript."), and that
		// first hit can fail the boundary test purely because of trailing
		// punctuation — which used to drop the skill entirely even though a
		// clean occurrence existed further down.
		found := false
		for from := 0; ; {
			rel := strings.Index(lower[from:], ls)
			if rel < 0 {
				break
			}
			idx := from + rel
			if boundedAt(lower, ls, idx) {
				found = true
				break
			}
			from = idx + 1
		}
		if !found {
			continue
		}
		canon := s
		if s == "Golang" {
			canon = "Go"
		}
		if seen[canon] {
			continue
		}
		seen[canon] = true
		out = append(out, canon)
	}
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out
}

func boundedAt(hay, needle string, idx int) bool {
	isWord := func(b byte) bool {
		return b == '+' || b == '#' || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
	}
	if idx > 0 && isWord(hay[idx-1]) {
		return false
	}
	end := idx + len(needle)
	if end < len(hay) {
		// A dot only continues a word when a letter follows it ("node.js"); a
		// sentence-ending period must not disqualify the match.
		if hay[end] == '.' {
			if end+1 < len(hay) && hay[end+1] >= 'a' && hay[end+1] <= 'z' {
				return false
			}
		} else if isWord(hay[end]) {
			return false
		}
	}
	return true
}

func findLinks(text string) []SocialLink {
	seen := map[string]bool{}
	var out []SocialLink
	for _, m := range reURL.FindAllStringSubmatch(text, -1) {
		host := strings.ToLower(m[1])
		path := m[2]
		// Skip bare email domains and obvious non-links.
		if host == "" || strings.HasSuffix(host, ".png") || strings.HasSuffix(host, ".jpg") {
			continue
		}
		full := host + path
		if seen[full] {
			continue
		}

		platform := "other"
		handle := ""
		for _, p := range platformHosts {
			if strings.Contains(host, p.match) {
				platform = p.platform
				handle = firstPathSegment(path)
				break
			}
		}
		// Ignore bare domains for known platforms (e.g. "github.com" with no user).
		if platform != "other" && handle == "" {
			continue
		}
		// For unknown hosts only keep things that look like a personal site.
		if platform == "other" {
			if !strings.Contains(text, "://"+host) && !strings.Contains(text, "www."+host) {
				continue
			}
			if strings.Contains(host, "gmail.") || strings.Contains(host, "outlook.") ||
				strings.Contains(host, "yahoo.") || strings.Contains(host, "hotmail.") {
				continue
			}
			platform = "portfolio"
		}

		seen[full] = true
		out = append(out, SocialLink{Platform: platform, URL: "https://" + full, Handle: handle})
	}
	if out == nil {
		out = []SocialLink{}
	}
	return out
}

func firstPathSegment(path string) string {
	p := strings.Trim(path, "/")
	if p == "" {
		return ""
	}
	seg := strings.SplitN(p, "/", 2)[0]
	seg = strings.SplitN(seg, "?", 2)[0]
	if seg == "in" || seg == "pub" { // linkedin.com/in/<handle>
		rest := strings.Trim(strings.TrimPrefix(p, seg), "/")
		return strings.SplitN(rest, "/", 2)[0]
	}
	return seg
}

// githubHandle returns the GitHub username from parsed links, if present.
func (c ParsedCV) githubHandle() string {
	for _, l := range c.Links {
		if l.Platform == "github" && l.Handle != "" {
			return l.Handle
		}
	}
	return ""
}
