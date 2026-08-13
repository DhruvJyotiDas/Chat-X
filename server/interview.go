package main

// Virtual Interview API.
//
// Orchestration lives here; the model lives on a separate GPU VM behind
// interview_gpu.go. Everything that does NOT need the model — CV upload,
// parsing, GitHub enrichment, history — works with no GPU configured at all,
// which is the intended state until that machine exists.
//
// NOTE ON MEDIA: answer audio and camera frames are forwarded to the GPU service
// and then discarded. They are never written to MariaDB. Chat attachments already
// showed why (base64 in LONGTEXT against a 16MB max_allowed_packet caps the file
// size around 11MB); interview audio is an order of magnitude larger. Only
// transcripts and scores are persisted.

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	maxCVBytes     = 8 * 1024 * 1024  // a CV that isn't a scan is far below this
	maxAnswerBytes = 12 * 1024 * 1024 // ~90s of 16kHz mono WAV + 6 JPEG frames, base64
	maxQuestions   = 12
)

func migrateInterview() {
	for _, s := range []string{
		`CREATE TABLE IF NOT EXISTS interview_profiles (
			id VARCHAR(64) PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			file_name TEXT,
			full_name VARCHAR(255), email VARCHAR(255), phone VARCHAR(64),
			headline TEXT, location VARCHAR(255), summary TEXT,
			skills JSON, links JSON, github JSON,
			text_length INT DEFAULT 0,
			created_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS interview_sessions (
			id VARCHAR(64) PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			profile_id VARCHAR(64),
			role VARCHAR(255) NOT NULL, seniority VARCHAR(32) NOT NULL,
			kind VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'created',
			overall_score DECIMAL(4,1), report JSON,
			created_at DATETIME(6) DEFAULT NOW(6), completed_at DATETIME(6),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS interview_questions (
			id VARCHAR(64) PRIMARY KEY,
			session_id VARCHAR(64) NOT NULL,
			idx INT NOT NULL, text TEXT NOT NULL,
			category VARCHAR(64), rationale TEXT, expected_points JSON,
			FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE)`,
		// Deliberately no media columns — see the note at the top of this file.
		`CREATE TABLE IF NOT EXISTS interview_answers (
			id VARCHAR(64) PRIMARY KEY,
			session_id VARCHAR(64) NOT NULL, question_id VARCHAR(64) NOT NULL,
			transcript MEDIUMTEXT, duration_sec DECIMAL(7,2) DEFAULT 0,
			scores JSON, overall DECIMAL(4,1),
			strengths JSON, improvements JSON, feedback TEXT,
			filler_words INT DEFAULT 0, words_per_minute INT DEFAULT 0,
			answered_at DATETIME(6) DEFAULT NOW(6),
			FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS idx_iv_sessions_user ON interview_sessions(user_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_iv_questions_session ON interview_questions(session_id, idx)`,
		`CREATE INDEX IF NOT EXISTS idx_iv_answers_session ON interview_answers(session_id)`,
		`CREATE INDEX IF NOT EXISTS idx_iv_profiles_user ON interview_profiles(user_id, created_at)`,
	} {
		if _, err := db.Exec(s); err != nil {
			log.Fatalf("interview migration: %v", err)
		}
	}
	log.Println("[DB] interview schema OK")
}

// ─── Shared shapes ───────────────────────────────────────────────────────────

type interviewProfile struct {
	ID        string         `json:"id"`
	FileName  string         `json:"fileName"`
	FullName  string         `json:"fullName,omitempty"`
	Email     string         `json:"email,omitempty"`
	Phone     string         `json:"phone,omitempty"`
	Headline  string         `json:"headline,omitempty"`
	Location  string         `json:"location,omitempty"`
	Summary   string         `json:"summary,omitempty"`
	Skills    []string       `json:"skills"`
	Links     []SocialLink   `json:"links"`
	GitHub    *GitHubProfile `json:"github,omitempty"`
	CreatedAt string         `json:"createdAt"`
}

type interviewQuestion struct {
	ID             string   `json:"id"`
	Index          int      `json:"index"`
	Text           string   `json:"text"`
	Category       string   `json:"category"`
	Rationale      string   `json:"rationale,omitempty"`
	ExpectedPoints []string `json:"expectedPoints,omitempty"`
}

type interviewAnswer struct {
	QuestionID     string             `json:"questionId"`
	Transcript     string             `json:"transcript"`
	DurationSec    float64            `json:"durationSec"`
	Scores         map[string]float64 `json:"scores"`
	Overall        float64            `json:"overall"`
	Strengths      []string           `json:"strengths"`
	Improvements   []string           `json:"improvements"`
	Feedback       string             `json:"feedback"`
	FillerWords    int                `json:"fillerWords"`
	WordsPerMinute int                `json:"wordsPerMinute"`
	AnsweredAt     string             `json:"answeredAt"`
}

type interviewSession struct {
	ID           string              `json:"id"`
	ProfileID    string              `json:"profileId"`
	Role         string              `json:"role"`
	Seniority    string              `json:"seniority"`
	Kind         string              `json:"kind"`
	Status       string              `json:"status"`
	OverallScore *float64            `json:"overallScore,omitempty"`
	Report       *GPUReport          `json:"report,omitempty"`
	Questions    []interviewQuestion `json:"questions"`
	Answers      []interviewAnswer   `json:"answers"`
	CreatedAt    string              `json:"createdAt"`
	CompletedAt  string              `json:"completedAt,omitempty"`
}

func jsonCol(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("null")
	}
	return b
}

// gpuFail maps engine errors to an HTTP status + message the UI can act on.
// A missing GPU is 503 (try later), bad credentials is 502 (our problem).
func gpuFail(w http.ResponseWriter, err error) {
	switch err {
	case ErrGPUNotConfigured:
		fail(w, "The interview engine is not connected yet. CV upload and your history still work.", 503)
	case ErrGPUUnreachable:
		fail(w, "The interview engine is unreachable right now. Please try again shortly.", 503)
	case ErrGPULoading:
		fail(w, "The interview engine is still starting up — this takes a couple of minutes after a restart.", 503)
	case ErrGPUUnauthorized:
		fail(w, "The interview engine rejected our credentials. This needs an administrator.", 502)
	default:
		fail(w, err.Error(), 502)
	}
}

// ─── GET /api/interview/status ───────────────────────────────────────────────
// Lets the UI say something honest before the user invests effort.

func handleInterviewStatus(w http.ResponseWriter, r *http.Request) {
	if _, err := bearerUID(r); err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	out := map[string]any{"configured": gpuConfigured(), "ready": false, "speech": false}
	if !gpuConfigured() {
		out["detail"] = "The AI interviewer runs on a separate GPU machine that is not connected yet."
		ok(w, out)
		return
	}
	h, err := gpuCheckHealth(r.Context())
	switch err {
	case nil:
		out["ready"] = true
		out["model"] = h.Model
	case ErrGPULoading:
		out["detail"] = "The interview engine is starting up."
	default:
		out["detail"] = err.Error()
	}
	ok(w, out)
}

// ─── POST /api/interview/cv ──────────────────────────────────────────────────

func handleInterviewCV(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	var body struct {
		FileName string `json:"fileName"`
		DataB64  string `json:"dataB64"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxCVBytes+1024)).Decode(&body); err != nil {
		fail(w, "Could not read the upload", 400)
		return
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.DataB64))
	if err != nil {
		fail(w, "The uploaded file could not be decoded", 400)
		return
	}
	if len(raw) == 0 {
		fail(w, "That file is empty", 400)
		return
	}
	if len(raw) > maxCVBytes {
		fail(w, "That file is too large — CVs should be under 8 MB", 413)
		return
	}

	text, err := extractText(body.FileName, raw)
	if err != nil {
		fail(w, err.Error(), 422)
		return
	}
	parsed := parseCV(text)

	// GitHub enrichment is best-effort and never blocks the upload.
	var gh *GitHubProfile
	if handle := parsed.githubHandle(); handle != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		p := fetchGitHub(ctx, handle)
		cancel()
		gh = &p
	}

	id := "ivp_" + newID()
	if _, err := db.Exec(`INSERT INTO interview_profiles
		(id,user_id,file_name,full_name,email,phone,headline,location,summary,skills,links,github,text_length)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, uid, body.FileName, parsed.FullName, parsed.Email, parsed.Phone,
		parsed.Headline, parsed.Location, parsed.Summary,
		jsonCol(parsed.Skills), jsonCol(parsed.Links), jsonCol(gh), parsed.TextLength,
	); err != nil {
		log.Printf("[Interview] saving profile failed: %v", err)
		fail(w, "Could not save the parsed CV", 500)
		return
	}
	log.Printf("[Interview] CV parsed for %s: %d chars, %d skills, %d links, github=%v",
		uid, parsed.TextLength, len(parsed.Skills), len(parsed.Links), gh != nil)

	ok(w, interviewProfile{
		ID: id, FileName: body.FileName, FullName: parsed.FullName, Email: parsed.Email,
		Phone: parsed.Phone, Headline: parsed.Headline, Location: parsed.Location,
		Summary: parsed.Summary, Skills: parsed.Skills, Links: parsed.Links, GitHub: gh,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func loadProfile(id, uid string) (interviewProfile, map[string]any, error) {
	var p interviewProfile
	var skills, links, ghRaw sql.NullString
	var created time.Time
	err := db.QueryRow(`SELECT id,file_name,full_name,email,phone,headline,location,summary,
		skills,links,github,created_at FROM interview_profiles WHERE id=? AND user_id=?`, id, uid).
		Scan(&p.ID, &p.FileName, &p.FullName, &p.Email, &p.Phone, &p.Headline, &p.Location,
			&p.Summary, &skills, &links, &ghRaw, &created)
	if err != nil {
		return p, nil, err
	}
	p.CreatedAt = created.UTC().Format(time.RFC3339)
	_ = json.Unmarshal([]byte(skills.String), &p.Skills)
	_ = json.Unmarshal([]byte(links.String), &p.Links)
	if ghRaw.Valid && ghRaw.String != "null" && ghRaw.String != "" {
		var g GitHubProfile
		if json.Unmarshal([]byte(ghRaw.String), &g) == nil {
			p.GitHub = &g
		}
	}
	if p.Skills == nil {
		p.Skills = []string{}
	}
	if p.Links == nil {
		p.Links = []SocialLink{}
	}

	// The shape the GPU service expects (gpu/CONTRACT.md).
	forModel := map[string]any{
		"full_name": p.FullName, "headline": p.Headline, "summary": p.Summary,
		"location": p.Location, "skills": p.Skills,
	}
	if p.GitHub != nil {
		forModel["github"] = map[string]any{
			"login": p.GitHub.Login, "bio": p.GitHub.Bio,
			"top_languages": p.GitHub.TopLanguages, "top_repos": p.GitHub.TopRepos,
			"public_repos": p.GitHub.PublicRepos, "total_stars": p.GitHub.TotalStars,
		}
	}
	return p, forModel, nil
}

// ─── POST /api/interview/sessions ────────────────────────────────────────────

func handleInterviewCreateSession(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	var body struct {
		ProfileID string `json:"profileId"`
		Role      string `json:"role"`
		Seniority string `json:"seniority"`
		Kind      string `json:"kind"`
		Count     int    `json:"count"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		fail(w, "Bad request", 400)
		return
	}
	body.Role = strings.TrimSpace(body.Role)
	if body.Role == "" {
		fail(w, "Tell us the role you're interviewing for", 400)
		return
	}
	if body.Count <= 0 || body.Count > maxQuestions {
		body.Count = 6
	}
	if body.Seniority == "" {
		body.Seniority = "junior"
	}
	if body.Kind == "" {
		body.Kind = "mixed"
	}

	prof, forModel, err := loadProfile(body.ProfileID, uid)
	if err != nil {
		fail(w, "Upload a CV first", 400)
		return
	}

	questions, err := gpuPlan(r.Context(), forModel, body.Role, body.Seniority, body.Kind, body.Count)
	if err != nil {
		gpuFail(w, err)
		return
	}

	sid := "ivs_" + newID()
	tx, err := db.Begin()
	if err != nil {
		fail(w, "Could not start the interview", 500)
		return
	}
	defer tx.Rollback() //nolint
	if _, err := tx.Exec(`INSERT INTO interview_sessions
		(id,user_id,profile_id,role,seniority,kind,status) VALUES (?,?,?,?,?,?,'in_progress')`,
		sid, uid, prof.ID, body.Role, body.Seniority, body.Kind); err != nil {
		fail(w, "Could not start the interview", 500)
		return
	}
	out := make([]interviewQuestion, 0, len(questions))
	for i, q := range questions {
		qid := "ivq_" + newID()
		if _, err := tx.Exec(`INSERT INTO interview_questions
			(id,session_id,idx,text,category,rationale,expected_points) VALUES (?,?,?,?,?,?,?)`,
			qid, sid, i, q.Text, q.Category, q.Rationale, jsonCol(q.ExpectedPoints)); err != nil {
			fail(w, "Could not save the questions", 500)
			return
		}
		out = append(out, interviewQuestion{
			ID: qid, Index: i, Text: q.Text, Category: q.Category,
			Rationale: q.Rationale, ExpectedPoints: q.ExpectedPoints,
		})
	}
	if err := tx.Commit(); err != nil {
		fail(w, "Could not start the interview", 500)
		return
	}
	log.Printf("[Interview] session %s started for %s: %s / %s / %s, %d questions",
		sid, uid, body.Role, body.Seniority, body.Kind, len(out))

	ok(w, interviewSession{
		ID: sid, ProfileID: prof.ID, Role: body.Role, Seniority: body.Seniority,
		Kind: body.Kind, Status: "in_progress", Questions: out, Answers: []interviewAnswer{},
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

// ─── POST /api/interview/sessions/{id}/answer ────────────────────────────────

func handleInterviewAnswer(w http.ResponseWriter, r *http.Request, sid string) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	var body struct {
		QuestionID  string   `json:"questionId"`
		AudioWavB64 string   `json:"audioWavB64"`
		FramesB64   []string `json:"framesB64"`
		DurationSec float64  `json:"durationSec"`
		Transcript  string   `json:"transcript"` // client-side fallback, optional
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAnswerBytes)).Decode(&body); err != nil {
		fail(w, "That answer was too large to upload", 413)
		return
	}

	var role, seniority, status string
	if err := db.QueryRow(`SELECT role,seniority,status FROM interview_sessions WHERE id=? AND user_id=?`,
		sid, uid).Scan(&role, &seniority, &status); err != nil {
		fail(w, "Interview not found", 404)
		return
	}
	if status == "completed" {
		fail(w, "That interview is already finished", 409)
		return
	}

	var qText, qCategory string
	var expectedRaw sql.NullString
	if err := db.QueryRow(`SELECT text,category,expected_points FROM interview_questions
		WHERE id=? AND session_id=?`, body.QuestionID, sid).Scan(&qText, &qCategory, &expectedRaw); err != nil {
		fail(w, "Question not found", 404)
		return
	}
	var expected []string
	_ = json.Unmarshal([]byte(expectedRaw.String), &expected)

	// Transcribe unless the client already did (browser speech recognition).
	transcript := strings.TrimSpace(body.Transcript)
	duration := body.DurationSec
	if transcript == "" && body.AudioWavB64 != "" {
		t, err := gpuTranscribe(r.Context(), body.AudioWavB64)
		if err != nil {
			gpuFail(w, err)
			return
		}
		transcript = t.Text
		if duration == 0 {
			duration = t.DurationSec
		}
	}
	if strings.TrimSpace(transcript) == "" {
		fail(w, "We couldn't hear an answer — check your microphone and try again", 422)
		return
	}

	evalReq := map[string]any{
		"question": qText, "expected_points": expected,
		"transcript": transcript, "duration_sec": duration,
		"role": role, "seniority": seniority,
	}
	if body.AudioWavB64 != "" {
		evalReq["audio_wav_b64"] = body.AudioWavB64
	}
	if len(body.FramesB64) > 0 {
		evalReq["frames_b64"] = body.FramesB64
	}
	ev, err := gpuEvaluate(r.Context(), evalReq)
	if err != nil {
		gpuFail(w, err)
		return
	}

	// Audio and frames are NOT persisted — see the file header.
	if _, err := db.Exec(`INSERT INTO interview_answers
		(id,session_id,question_id,transcript,duration_sec,scores,overall,strengths,improvements,
		 feedback,filler_words,words_per_minute) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		"iva_"+newID(), sid, body.QuestionID, transcript, duration,
		jsonCol(ev.Scores), ev.Overall, jsonCol(ev.Strengths), jsonCol(ev.Improvements),
		ev.Feedback, ev.FillerWordCount, ev.WordsPerMinute,
	); err != nil {
		log.Printf("[Interview] saving answer failed: %v", err)
		fail(w, "Could not save that answer", 500)
		return
	}

	ok(w, interviewAnswer{
		QuestionID: body.QuestionID, Transcript: transcript, DurationSec: duration,
		Scores: ev.Scores, Overall: ev.Overall, Strengths: ev.Strengths,
		Improvements: ev.Improvements, Feedback: ev.Feedback,
		FillerWords: ev.FillerWordCount, WordsPerMinute: ev.WordsPerMinute,
		AnsweredAt: time.Now().UTC().Format(time.RFC3339),
	})
}

// ─── POST /api/interview/sessions/{id}/finish ────────────────────────────────

func handleInterviewFinish(w http.ResponseWriter, r *http.Request, sid string) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	var role, seniority string
	if err := db.QueryRow(`SELECT role,seniority FROM interview_sessions WHERE id=? AND user_id=?`,
		sid, uid).Scan(&role, &seniority); err != nil {
		fail(w, "Interview not found", 404)
		return
	}

	answers, err := loadAnswers(sid)
	if err != nil {
		fail(w, "Could not load your answers", 500)
		return
	}
	if len(answers) == 0 {
		fail(w, "Answer at least one question before finishing", 400)
		return
	}

	forModel := make([]map[string]any, 0, len(answers))
	for _, a := range answers {
		forModel = append(forModel, map[string]any{
			"question": a.QuestionID, "transcript": a.Transcript, "scores": a.Scores,
		})
	}
	rep, err := gpuReport(r.Context(), role, seniority, forModel)
	if err != nil {
		gpuFail(w, err)
		return
	}

	if _, err := db.Exec(`UPDATE interview_sessions
		SET status='completed', overall_score=?, report=?, completed_at=NOW(6) WHERE id=? AND user_id=?`,
		rep.Overall, jsonCol(rep), sid, uid); err != nil {
		fail(w, "Could not save the report", 500)
		return
	}
	log.Printf("[Interview] session %s completed for %s: overall %.1f over %d answers",
		sid, uid, rep.Overall, len(answers))
	ok(w, rep)
}

func loadAnswers(sid string) ([]interviewAnswer, error) {
	rows, err := db.Query(`SELECT question_id,transcript,duration_sec,scores,overall,strengths,
		improvements,feedback,filler_words,words_per_minute,answered_at
		FROM interview_answers WHERE session_id=? ORDER BY answered_at`, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []interviewAnswer{}
	for rows.Next() {
		var a interviewAnswer
		var scores, strengths, improvements sql.NullString
		var at time.Time
		if err := rows.Scan(&a.QuestionID, &a.Transcript, &a.DurationSec, &scores, &a.Overall,
			&strengths, &improvements, &a.Feedback, &a.FillerWords, &a.WordsPerMinute, &at); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(scores.String), &a.Scores)
		_ = json.Unmarshal([]byte(strengths.String), &a.Strengths)
		_ = json.Unmarshal([]byte(improvements.String), &a.Improvements)
		a.AnsweredAt = at.UTC().Format(time.RFC3339)
		out = append(out, a)
	}
	return out, rows.Err()
}

// ─── GET /api/interview/sessions  ·  GET /api/interview/sessions/{id} ────────

func handleInterviewList(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	rows, err := db.Query(`SELECT id,profile_id,role,seniority,kind,status,overall_score,
		created_at,completed_at FROM interview_sessions WHERE user_id=?
		ORDER BY created_at DESC LIMIT 50`, uid)
	if err != nil {
		fail(w, "Could not load your interviews", 500)
		return
	}
	defer rows.Close()
	out := []interviewSession{}
	for rows.Next() {
		var s interviewSession
		var pid sql.NullString
		var score sql.NullFloat64
		var created time.Time
		var completed sql.NullTime
		if err := rows.Scan(&s.ID, &pid, &s.Role, &s.Seniority, &s.Kind, &s.Status,
			&score, &created, &completed); err != nil {
			continue
		}
		s.ProfileID = pid.String
		if score.Valid {
			v := score.Float64
			s.OverallScore = &v
		}
		s.CreatedAt = created.UTC().Format(time.RFC3339)
		if completed.Valid {
			s.CompletedAt = completed.Time.UTC().Format(time.RFC3339)
		}
		s.Questions = []interviewQuestion{}
		s.Answers = []interviewAnswer{}
		out = append(out, s)
	}
	ok(w, out)
}

func handleInterviewGet(w http.ResponseWriter, r *http.Request, sid string) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	var s interviewSession
	var pid sql.NullString
	var score sql.NullFloat64
	var reportRaw sql.NullString
	var created time.Time
	var completed sql.NullTime
	if err := db.QueryRow(`SELECT id,profile_id,role,seniority,kind,status,overall_score,report,
		created_at,completed_at FROM interview_sessions WHERE id=? AND user_id=?`, sid, uid).
		Scan(&s.ID, &pid, &s.Role, &s.Seniority, &s.Kind, &s.Status, &score, &reportRaw,
			&created, &completed); err != nil {
		fail(w, "Interview not found", 404)
		return
	}
	s.ProfileID = pid.String
	if score.Valid {
		v := score.Float64
		s.OverallScore = &v
	}
	if reportRaw.Valid && reportRaw.String != "" && reportRaw.String != "null" {
		var rep GPUReport
		if json.Unmarshal([]byte(reportRaw.String), &rep) == nil {
			s.Report = &rep
		}
	}
	s.CreatedAt = created.UTC().Format(time.RFC3339)
	if completed.Valid {
		s.CompletedAt = completed.Time.UTC().Format(time.RFC3339)
	}

	qrows, err := db.Query(`SELECT id,idx,text,category,rationale,expected_points
		FROM interview_questions WHERE session_id=? ORDER BY idx`, sid)
	if err == nil {
		defer qrows.Close()
		for qrows.Next() {
			var q interviewQuestion
			var expected sql.NullString
			if qrows.Scan(&q.ID, &q.Index, &q.Text, &q.Category, &q.Rationale, &expected) == nil {
				_ = json.Unmarshal([]byte(expected.String), &q.ExpectedPoints)
				s.Questions = append(s.Questions, q)
			}
		}
	}
	if s.Questions == nil {
		s.Questions = []interviewQuestion{}
	}
	if a, err := loadAnswers(sid); err == nil {
		s.Answers = a
	} else {
		s.Answers = []interviewAnswer{}
	}
	ok(w, s)
}

func handleInterviewProfiles(w http.ResponseWriter, r *http.Request) {
	uid, err := bearerUID(r)
	if err != nil {
		fail(w, "Unauthorized", 401)
		return
	}
	rows, err := db.Query(`SELECT id FROM interview_profiles WHERE user_id=?
		ORDER BY created_at DESC LIMIT 1`, uid)
	if err != nil {
		fail(w, "Could not load your CV", 500)
		return
	}
	defer rows.Close()
	if !rows.Next() {
		ok(w, nil)
		return
	}
	var id string
	_ = rows.Scan(&id)
	rows.Close()
	p, _, err := loadProfile(id, uid)
	if err != nil {
		ok(w, nil)
		return
	}
	ok(w, p)
}

// ─── Router ──────────────────────────────────────────────────────────────────

func handleInterviewRoutes(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/interview/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")

	switch {
	case parts[0] == "status" && r.Method == "GET":
		handleInterviewStatus(w, r)
	case parts[0] == "cv" && r.Method == "POST":
		handleInterviewCV(w, r)
	case parts[0] == "profile" && r.Method == "GET":
		handleInterviewProfiles(w, r)
	case parts[0] == "sessions" && len(parts) == 1 && r.Method == "GET":
		handleInterviewList(w, r)
	case parts[0] == "sessions" && len(parts) == 1 && r.Method == "POST":
		handleInterviewCreateSession(w, r)
	case parts[0] == "sessions" && len(parts) == 2 && r.Method == "GET":
		handleInterviewGet(w, r, parts[1])
	case parts[0] == "sessions" && len(parts) == 3 && parts[2] == "answer" && r.Method == "POST":
		handleInterviewAnswer(w, r, parts[1])
	case parts[0] == "sessions" && len(parts) == 3 && parts[2] == "finish" && r.Method == "POST":
		handleInterviewFinish(w, r, parts[1])
	default:
		fail(w, fmt.Sprintf("Unknown interview route: %s %s", r.Method, r.URL.Path), 404)
	}
}
