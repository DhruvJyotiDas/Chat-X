package main

// GitHub enrichment.
//
// This is the only social profile that can honestly be enriched. LinkedIn has no
// public API, blocks logged-out profile fetches, and scraping it violates their
// terms — so a LinkedIn URL found in a CV is surfaced as a link and nothing more.
// GitHub, by contrast, publishes everything we want through a documented public
// API, so an interviewer can legitimately ask about the code someone has shipped.
//
// Unauthenticated requests are limited to 60/hour per IP, which is easy to
// exhaust. Results are therefore cached per handle, and a rate-limit response is
// reported as a normal outcome rather than an error — an enriched profile is a
// bonus, never a requirement for running an interview.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type GitHubRepo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Language    string `json:"language,omitempty"`
	Stars       int    `json:"stars"`
	URL         string `json:"url"`
}

type GitHubProfile struct {
	Login         string       `json:"login"`
	Name          string       `json:"name,omitempty"`
	Bio           string       `json:"bio,omitempty"`
	AvatarURL     string       `json:"avatarUrl,omitempty"`
	Company       string       `json:"company,omitempty"`
	Location      string       `json:"location,omitempty"`
	Blog          string       `json:"blog,omitempty"`
	PublicRepos   int          `json:"publicRepos"`
	Followers     int          `json:"followers"`
	CreatedAt     string       `json:"createdAt,omitempty"`
	TopLanguages  []string     `json:"topLanguages"`
	TopRepos      []GitHubRepo `json:"topRepos"`
	TotalStars    int          `json:"totalStars"`
	FetchedAt     string       `json:"fetchedAt"`
	Unavailable   string       `json:"unavailable,omitempty"` // why enrichment was skipped
}

type ghCacheEntry struct {
	profile GitHubProfile
	at      time.Time
}

var (
	ghMu    sync.Mutex
	ghCache = map[string]ghCacheEntry{}
)

const ghCacheTTL = 6 * time.Hour

var ghHTTP = &http.Client{Timeout: 12 * time.Second}

func ghRequest(ctx context.Context, url string, out any) (int, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "IB-Connect-Interview")
	// Optional: a token lifts the limit from 60/hr to 5000/hr. Never hardcoded —
	// this repo is public.
	if t := os.Getenv("GITHUB_TOKEN"); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	res, err := ghHTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024))
	if err != nil {
		return res.StatusCode, err
	}
	if res.StatusCode != 200 {
		return res.StatusCode, fmt.Errorf("github returned %d", res.StatusCode)
	}
	return 200, json.Unmarshal(body, out)
}

// fetchGitHub never returns an error: enrichment failing must not block a CV
// upload. Failures come back inside the struct as `Unavailable`, which the UI
// shows as a note rather than an error.
func fetchGitHub(ctx context.Context, handle string) GitHubProfile {
	handle = strings.TrimSpace(strings.Trim(handle, "/"))
	if handle == "" {
		return GitHubProfile{Unavailable: "no GitHub handle found in the CV"}
	}

	ghMu.Lock()
	if e, ok := ghCache[strings.ToLower(handle)]; ok && time.Since(e.at) < ghCacheTTL {
		ghMu.Unlock()
		return e.profile
	}
	ghMu.Unlock()

	var user struct {
		Login       string `json:"login"`
		Name        string `json:"name"`
		Bio         string `json:"bio"`
		AvatarURL   string `json:"avatar_url"`
		Company     string `json:"company"`
		Location    string `json:"location"`
		Blog        string `json:"blog"`
		PublicRepos int    `json:"public_repos"`
		Followers   int    `json:"followers"`
		CreatedAt   string `json:"created_at"`
	}

	status, err := ghRequest(ctx, "https://api.github.com/users/"+handle, &user)
	if err != nil {
		reason := "GitHub could not be reached"
		switch status {
		case 404:
			reason = fmt.Sprintf("GitHub user %q was not found", handle)
		case 403, 429:
			reason = "GitHub rate limit reached — try again later"
		}
		log.Printf("[Interview] github enrichment for %q skipped: %s (%v)", handle, reason, err)
		p := GitHubProfile{Login: handle, Unavailable: reason, FetchedAt: time.Now().UTC().Format(time.RFC3339)}
		return p
	}

	prof := GitHubProfile{
		Login: user.Login, Name: user.Name, Bio: user.Bio, AvatarURL: user.AvatarURL,
		Company: user.Company, Location: user.Location, Blog: user.Blog,
		PublicRepos: user.PublicRepos, Followers: user.Followers, CreatedAt: user.CreatedAt,
		TopLanguages: []string{}, TopRepos: []GitHubRepo{},
		FetchedAt: time.Now().UTC().Format(time.RFC3339),
	}

	var repos []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Language    string `json:"language"`
		Stars       int    `json:"stargazers_count"`
		HTMLURL     string `json:"html_url"`
		Fork        bool   `json:"fork"`
		Archived    bool   `json:"archived"`
	}
	if _, err := ghRequest(ctx,
		"https://api.github.com/users/"+handle+"/repos?per_page=100&sort=pushed", &repos); err == nil {

		langCount := map[string]int{}
		for _, r := range repos {
			// Forks say nothing about what someone can build, so exclude them
			// from both the language mix and the highlighted repos.
			if r.Fork || r.Archived {
				continue
			}
			if r.Language != "" {
				langCount[r.Language]++
			}
			prof.TotalStars += r.Stars
			prof.TopRepos = append(prof.TopRepos, GitHubRepo{
				Name: r.Name, Description: r.Description, Language: r.Language,
				Stars: r.Stars, URL: r.HTMLURL,
			})
		}
		sort.Slice(prof.TopRepos, func(i, j int) bool {
			return prof.TopRepos[i].Stars > prof.TopRepos[j].Stars
		})
		if len(prof.TopRepos) > 6 {
			prof.TopRepos = prof.TopRepos[:6]
		}

		type lc struct {
			lang string
			n    int
		}
		var ls []lc
		for l, n := range langCount {
			ls = append(ls, lc{l, n})
		}
		sort.Slice(ls, func(i, j int) bool { return ls[i].n > ls[j].n })
		for i, l := range ls {
			if i >= 6 {
				break
			}
			prof.TopLanguages = append(prof.TopLanguages, l.lang)
		}
	}

	ghMu.Lock()
	ghCache[strings.ToLower(handle)] = ghCacheEntry{prof, time.Now()}
	ghMu.Unlock()
	return prof
}
