package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"time"
)

// Mailer sends the transactional emails. Transport is chosen automatically:
//
//	EMAIL_API_KEY set  → HTTPS email API (Brevo / Resend) — works when only
//	                     outbound 443 is open
//	SMTP_HOST set       → direct SMTP submission (needs outbound 587/465)
//	neither            → "log mode": the message is written to the journal so
//	                     the OTP / reset flow still works with nothing configured
//
// Any send failure also falls back to logging the body, so a code is never lost.
type Mailer struct {
	cfg *Config
	hc  *http.Client
}

func newMailer(cfg *Config) *Mailer {
	return &Mailer{cfg: cfg, hc: &http.Client{Timeout: 20 * time.Second}}
}

func (m *Mailer) mode() string {
	if m.cfg.EmailAPIKey != "" {
		return "http"
	}
	if m.cfg.SMTPHost != "" {
		return "smtp"
	}
	return "log"
}
func (m *Mailer) logMode() bool { return m.mode() == "log" }

// send delivers one multipart/alternative message.
func (m *Mailer) send(to, subject, textBody, htmlBody string) {
	if m.logMode() {
		log.Printf("\n─── EMAIL (log mode — no transport configured) ───\nTo:      %s\nSubject: %s\n\n%s\n─────────────────────────────────────────────", to, subject, textBody)
		return
	}
	go func() {
		var err error
		if m.mode() == "http" {
			err = m.httpDeliver(to, subject, textBody, htmlBody)
		} else {
			err = m.deliver(to, subject, textBody, htmlBody)
		}
		if err != nil {
			// Don't lose the message: fall back to logging its body so an OTP /
			// reset code is still recoverable while mail delivery is broken.
			log.Printf("email: send to %s failed: %v — falling back to log:\n─── EMAIL (delivery failed) ───\nTo:      %s\nSubject: %s\n\n%s\n───────────────────────────────", to, err, to, subject, textBody)
		} else {
			log.Printf("email: sent %q to %s via %s", subject, to, m.mode())
		}
	}()
}

// splitFrom turns `IB Account <noreply@icebrkr.space>` into name + address.
func (m *Mailer) splitFrom() (name, addr string) {
	f := m.cfg.SMTPFrom
	if i := strings.LastIndex(f, "<"); i >= 0 {
		name = strings.TrimSpace(f[:i])
		addr = strings.TrimSuffix(strings.TrimSpace(f[i+1:]), ">")
		return
	}
	return "", strings.TrimSpace(f)
}

// httpDeliver sends via a provider's HTTPS API (port 443 only).
func (m *Mailer) httpDeliver(to, subject, textBody, htmlBody string) error {
	fromName, fromAddr := m.splitFrom()

	req := func(u string, body any) (*http.Request, error) {
		b, _ := json.Marshal(body)
		return http.NewRequest(http.MethodPost, u, bytes.NewReader(b))
	}

	var r *http.Request
	var err error
	switch m.cfg.EmailAPI {
	case "resend":
		r, err = req("https://api.resend.com/emails", map[string]any{
			"from": m.cfg.SMTPFrom, "to": []string{to},
			"subject": subject, "html": htmlBody, "text": textBody,
		})
		if err == nil {
			r.Header.Set("Authorization", "Bearer "+m.cfg.EmailAPIKey)
		}
	default: // brevo
		r, err = req("https://api.brevo.com/v3/smtp/email", map[string]any{
			"sender":      map[string]string{"name": fromName, "email": fromAddr},
			"to":          []map[string]string{{"email": to}},
			"subject":     subject,
			"htmlContent": htmlBody,
			"textContent": textBody,
		})
		if err == nil {
			r.Header.Set("api-key", m.cfg.EmailAPIKey)
		}
	}
	if err != nil {
		return err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json")

	resp, err := m.hc.Do(r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("%s api %s: %s", m.cfg.EmailAPI, resp.Status, strings.TrimSpace(string(body)))
}

func (m *Mailer) deliver(to, subject, textBody, htmlBody string) error {
	from := m.cfg.SMTPFrom
	fromAddr := from
	if i := strings.LastIndex(from, "<"); i >= 0 {
		fromAddr = strings.TrimSuffix(strings.TrimSpace(from[i+1:]), ">")
	}

	boundary := fmt.Sprintf("ibacct-%d", time.Now().UnixNano())
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", boundary)
	fmt.Fprintf(&b, "--%s\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n", boundary, textBody)
	fmt.Fprintf(&b, "--%s\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n%s\r\n", boundary, htmlBody)
	fmt.Fprintf(&b, "--%s--\r\n", boundary)

	addr := net.JoinHostPort(m.cfg.SMTPHost, fmt.Sprint(m.cfg.SMTPPort))
	var auth smtp.Auth
	if m.cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", m.cfg.SMTPUser, m.cfg.SMTPPass, m.cfg.SMTPHost)
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second}

	if m.cfg.SMTPPort == 465 { // implicit TLS
		raw, err := dialer.Dial("tcp", addr)
		if err != nil {
			return err
		}
		conn := tls.Client(raw, &tls.Config{ServerName: m.cfg.SMTPHost})
		if err := conn.Handshake(); err != nil {
			return err
		}
		c, err := smtp.NewClient(conn, m.cfg.SMTPHost)
		if err != nil {
			return err
		}
		defer c.Quit()
		return finishSMTP(c, auth, fromAddr, to, b.String())
	}

	raw, err := dialer.Dial("tcp", addr)
	if err != nil {
		return err
	}
	c, err := smtp.NewClient(raw, m.cfg.SMTPHost)
	if err != nil {
		return err
	}
	defer c.Quit()
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: m.cfg.SMTPHost}); err != nil {
			return err
		}
	}
	return finishSMTP(c, auth, fromAddr, to, b.String())
}

func finishSMTP(c *smtp.Client, auth smtp.Auth, from, to, msg string) error {
	if auth != nil {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(auth); err != nil {
				return err
			}
		}
	}
	if err := c.Mail(from); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	return w.Close()
}

// ── templates ───────────────────────────────────────────────────────────

func shell(title, bodyHTML string) string {
	return `<!doctype html><html><body style="margin:0;background:#0e0e0e;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e0e;padding:32px 0"><tr><td align="center">
<table width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%">
  <tr><td style="padding:0 0 20px 0">
    <span style="display:inline-block;width:34px;height:34px;border-radius:9px;background:#0066FF;color:#fff;font-weight:800;font-size:15px;line-height:34px;text-align:center">IB</span>
    <span style="color:#e5e2e1;font-weight:700;font-size:16px;vertical-align:middle;margin-left:10px">IB Account</span>
  </td></tr>
  <tr><td style="background:#131313;border:1px solid #2a2d38;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 14px 0;color:#e5e2e1;font-size:19px">` + html.EscapeString(title) + `</h1>
    ` + bodyHTML + `
  </td></tr>
  <tr><td style="padding:18px 4px;color:#6b7080;font-size:11px">
    IB Connect · Secure Enterprise Communication<br>
    If you didn't expect this email you can safely ignore it.
  </td></tr>
</table></td></tr></table></body></html>`
}

func codeBlockHTML(code string) string {
	return `<div style="margin:18px 0;text-align:center">
	<span style="display:inline-block;letter-spacing:8px;font-size:30px;font-weight:800;color:#7fb0ff;background:#0b1a33;border:1px solid #1e3a66;border-radius:12px;padding:14px 20px">` + html.EscapeString(code) + `</span></div>`
}

func p(s string) string {
	return `<p style="margin:0 0 12px 0;color:#b7bac6;font-size:14px;line-height:1.55">` + s + `</p>`
}

func greet(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Hi,"
	}
	return "Hi " + html.EscapeString(name) + ","
}

func (m *Mailer) sendVerify(to, name, code string) {
	mins := int(m.cfg.OTPTTL.Minutes())
	text := fmt.Sprintf("%s\n\nYour IB Account verification code is: %s\n\nIt expires in %d minutes.",
		greetPlain(name), code, mins)
	htmlBody := shell("Verify your email",
		p(greet(name))+
			p("Enter this code to finish creating your IB Account:")+
			codeBlockHTML(code)+
			p(fmt.Sprintf("The code expires in %d minutes.", mins)))
	m.send(to, "Your IB Account verification code", text, htmlBody)
}

func (m *Mailer) sendWelcome(to, name string) {
	text := greetPlain(name) + "\n\nYour IB Account is ready. You can now sign in to IB Connect and every other IB application with this one identity."
	htmlBody := shell("Welcome to IB",
		p(greet(name))+
			p("Your IB Account is ready. One identity now signs you in to IB Connect and every other IB application.")+
			p(`<a href="`+html.EscapeString(m.cfg.PublicURL)+`" style="color:#7fb0ff">Manage your account &rarr;</a>`))
	m.send(to, "Welcome to IB", text, htmlBody)
}

func (m *Mailer) sendReset(to, name, code string) {
	mins := int(m.cfg.OTPTTL.Minutes())
	text := fmt.Sprintf("%s\n\nYour IB Account password reset code is: %s\n\nIt expires in %d minutes. If you didn't request this, ignore this email — your password is unchanged.",
		greetPlain(name), code, mins)
	htmlBody := shell("Reset your password",
		p(greet(name))+
			p("Use this code to set a new password:")+
			codeBlockHTML(code)+
			p(fmt.Sprintf("The code expires in %d minutes. If you didn't request this, ignore this email — your password is unchanged.", mins)))
	m.send(to, "Reset your IB Account password", text, htmlBody)
}

func (m *Mailer) sendPasswordChanged(to, name string) {
	text := greetPlain(name) + "\n\nYour IB Account password was just changed. If this wasn't you, reset it immediately and contact your administrator."
	htmlBody := shell("Your password was changed",
		p(greet(name))+
			p("Your IB Account password was just changed.")+
			p("If this wasn't you, use <b>Forgot password</b> on the sign-in screen right away and contact your administrator."))
	m.send(to, "Your IB Account password was changed", text, htmlBody)
}

func (m *Mailer) sendNewLogin(to, name, ip, ua string, when time.Time) {
	line := fmt.Sprintf("%s · %s · %s", when.UTC().Format("2006-01-02 15:04 UTC"), ipOrUnknown(ip), uaOrUnknown(ua))
	text := greetPlain(name) + "\n\nNew sign-in to your IB Account:\n" + line + "\n\nIf this wasn't you, reset your password."
	htmlBody := shell("New sign-in to your account",
		p(greet(name))+
			p("Your IB Account was just used to sign in:")+
			p(`<span style="color:#e5e2e1">`+html.EscapeString(line)+`</span>`)+
			p("If this wasn't you, use <b>Forgot password</b> to lock the account down."))
	m.send(to, "New sign-in to your IB Account", text, htmlBody)
}

func greetPlain(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Hi,"
	}
	return "Hi " + name + ","
}
func ipOrUnknown(s string) string {
	if s == "" {
		return "unknown IP"
	}
	return s
}
func uaOrUnknown(s string) string {
	if s == "" {
		return "unknown device"
	}
	return s
}
