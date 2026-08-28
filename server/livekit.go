package main

// LiveKit access-token issuance — Stage 3 of the mesh->SFU migration.
//
// This is the ONLY place this backend talks to LiveKit. It does not call
// LiveKit's RoomService (no admin API use yet — LiveKit auto-creates a room
// on the first authorized join, which is enough for now); it only mints a
// short-lived JWT that authorizes a client's LiveKit SDK to connect.
//
// Deliberately kept separate from handleTurnCredentials (server/main.go) —
// two different credential systems, two different secrets, never merged into
// one endpoint or one response body. See the migration plan for why.

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// LiveKit's access token is a plain JWT with a documented claims shape
// (github.com/livekit/protocol/auth.ClaimGrants / VideoGrant) — the official
// server-sdk-go module that builds these pulls in NATS, Pion's full WebRTC
// stack, OpenTelemetry, protovalidate/CEL, and a Docker client, none of which
// this endpoint has any use for, just to sign a JWT. This hand-rolls the
// exact same claims shape (verified against the actual library source, not
// guessed) using golang-jwt/jwt/v5, which is already a dependency here for
// this app's own session tokens (see signToken/parseToken, server/main.go) —
// zero new third-party surface for something this self-contained.
type livekitVideoGrant struct {
	RoomJoin     bool   `json:"roomJoin,omitempty"`
	Room         string `json:"room,omitempty"`
	CanPublish   bool   `json:"canPublish"`
	CanSubscribe bool   `json:"canSubscribe"`
}

type livekitClaims struct {
	Identity string            `json:"identity,omitempty"`
	Name     string            `json:"name,omitempty"`
	Video    livekitVideoGrant `json:"video,omitempty"`
	jwt.RegisteredClaims
}

// livekitTokenTTL: how long the minted JWT is valid for the INITIAL connect
// handshake — not how long the resulting LiveKit session may last (LiveKit
// does not re-check token expiry against an already-established room
// connection; expiry only gates the handshake). Kept short because this is a
// higher-value credential than a TURN credential: it authorizes publishing
// and subscribing as a specific identity in a specific room, not just generic
// relay capability. A dropped LiveKit connection is expected to fetch a FRESH
// token on reconnect (mirroring reenterRoom's redial-from-scratch pattern in
// MeetingContext.tsx) rather than ever reuse an old one — that's what makes a
// short TTL safe instead of a liability for a long call.
const livekitTokenTTL = 10 * time.Minute

type livekitTokenRequest struct {
	RoomID   string `json:"room_id"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
}

type livekitTokenResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
}

// roomByCode is a tiny extraction of the lookup pattern already inlined twice
// in handleSignaling (create_room/join_room, server/main.go). NOT used to
// refactor those two existing call sites — this migration's scope is the
// LiveKit endpoint, not touching working, unrelated code, so they're left
// exactly as they are. This helper exists only so a third copy of the same
// four lines isn't pasted here.
func roomByCode(code string) (*Room, bool) {
	roomsMu.RLock()
	defer roomsMu.RUnlock()
	r, ok := rooms[code]
	return r, ok
}

// isRoomMember reuses the exact same check transcription_relay.go already
// uses to gate /asr (see its lines ~96-98) — this is the second consumer of
// that pattern, not a reimplementation of it.
func isRoomMember(room *Room, identity string) bool {
	room.mu.RLock()
	defer room.mu.RUnlock()
	_, ok := room.clients[identity]
	return ok
}

func handleLiveKitToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, "Method not allowed", 405)
		return
	}

	apiKey := os.Getenv("LIVEKIT_API_KEY")
	apiSecret := os.Getenv("LIVEKIT_API_SECRET")
	livekitURL := os.Getenv("LIVEKIT_URL")
	if apiKey == "" || apiSecret == "" || livekitURL == "" {
		fail(w, "LiveKit is not configured", 503)
		return
	}

	var body livekitTokenRequest
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.RoomID == "" {
		fail(w, "room_id is required", 400)
		return
	}

	// ── Identity resolution ──────────────────────────────────────────────────
	//
	// Signed-in caller: identity comes ONLY from the validated session JWT
	// (bearerUID — the same function every other authenticated endpoint in
	// this codebase uses, server/main.go:161-171). A request-body user_id is
	// never consulted when a valid session is present — that's what stops a
	// signed-in user from requesting a token claiming to be someone else.
	//
	// Guest caller: there is no session to validate — that's the existing,
	// deliberate join_room trust model (room-code knowledge is the entire
	// access control, guests included), and preserving it is a hard
	// requirement here. Identity necessarily comes from the request body in
	// this case, exactly as it already does for an unauthenticated /ws
	// join_room. This is not a new hole introduced by this endpoint — it's
	// the same trust boundary join_room already has, no better, no worse.
	identity := body.UserID
	name := body.UserName
	if uid, err := bearerUID(r); err == nil {
		identity = uid
	} else if identity == "" {
		fail(w, "user_id is required for a guest request", 400)
		return
	}

	// ── Authorization: membership, not admission ─────────────────────────────
	//
	// join_room's checks (room exists, not full — server/main.go:1710-1748)
	// are an ADMISSION gate: they run once, when a client is first getting
	// INTO a room over /ws. By the time a client asks for a LiveKit token it
	// should already be in the room — this checks CURRENT MEMBERSHIP instead,
	// the same question transcription_relay.go already asks before opening an
	// ASR stream. Re-running the admission check here would be answering the
	// wrong question, not extra safety.
	room, found := roomByCode(body.RoomID)
	if !found || !isRoomMember(room, identity) {
		fail(w, "not a member of this room", 403)
		return
	}

	now := time.Now()
	claims := livekitClaims{
		Identity: identity,
		Name:     name,
		Video: livekitVideoGrant{
			RoomJoin:     true,
			Room:         body.RoomID,
			CanPublish:   true,
			CanSubscribe: true,
		},
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    apiKey, // LiveKit identifies which API key/secret pair signed this by the `iss` claim
			Subject:   identity,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(livekitTokenTTL)),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(apiSecret))
	if err != nil {
		fail(w, "could not mint token", 500)
		return
	}

	ok(w, livekitTokenResponse{Token: token, URL: strings.TrimSuffix(livekitURL, "/")})
}
