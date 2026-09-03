package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
)

// SigningKey is the RSA key pair the OIDC id_tokens are signed with. The public
// half is published at <issuer>/oauth/jwks.json; IB Connect's backend fetches
// that to verify tokens (server/main.go fetchJWKS).
type SigningKey struct {
	Private *rsa.PrivateKey
	Kid     string
}

func loadOrCreateSigningKey(path string) (*SigningKey, error) {
	if b, err := os.ReadFile(path); err == nil {
		block, _ := pem.Decode(b)
		if block == nil {
			return nil, fmt.Errorf("signing key %s: not valid PEM", path)
		}
		key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			// try PKCS#8
			k8, err8 := x509.ParsePKCS8PrivateKey(block.Bytes)
			if err8 != nil {
				return nil, fmt.Errorf("signing key %s: %w", path, err)
			}
			rk, ok := k8.(*rsa.PrivateKey)
			if !ok {
				return nil, fmt.Errorf("signing key %s: not an RSA key", path)
			}
			key = rk
		}
		return &SigningKey{Private: key, Kid: kidFor(&key.PublicKey)}, nil
	}

	// Generate a fresh 2048-bit key and persist it (0600).
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return nil, err
	}
	return &SigningKey{Private: key, Kid: kidFor(&key.PublicKey)}, nil
}

// kidFor is a stable key id: first 16 hex chars of SHA-256 over the DER SPKI.
func kidFor(pub *rsa.PublicKey) string {
	der, _ := x509.MarshalPKIXPublicKey(pub)
	sum := sha256.Sum256(der)
	return fmt.Sprintf("%x", sum[:8])
}

// JWKS returns the single-key JWK Set document.
func (k *SigningKey) JWKS() map[string]any {
	pub := k.Private.PublicKey
	n := base64.RawURLEncoding.EncodeToString(pub.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())
	return map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": k.Kid,
			"n":   n,
			"e":   e,
		}},
	}
}
