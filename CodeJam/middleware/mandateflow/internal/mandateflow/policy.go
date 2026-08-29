package mandateflow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

type LoadedPolicy struct {
	Policy Policy
	Raw    []byte
	Hash   string
}

func LoadPolicy(path string) (LoadedPolicy, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return LoadedPolicy{}, fmt.Errorf("read policy: %w", err)
	}
	return ParsePolicy(raw)
}

func ParsePolicy(raw []byte) (LoadedPolicy, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var policy Policy
	if err := decoder.Decode(&policy); err != nil {
		return LoadedPolicy{}, fmt.Errorf("decode policy: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return LoadedPolicy{}, fmt.Errorf("decode policy: trailing JSON value")
	}
	if err := validatePolicy(policy); err != nil {
		return LoadedPolicy{}, err
	}
	canonical, err := json.Marshal(policy)
	if err != nil {
		return LoadedPolicy{}, fmt.Errorf("canonicalize policy: %w", err)
	}
	digest := sha256.Sum256(canonical)
	return LoadedPolicy{Policy: policy, Raw: canonical, Hash: hex.EncodeToString(digest[:])}, nil
}

func validatePolicy(policy Policy) error {
	if policy.ID != PolicyIDMixedOperations || policy.Version != PolicyVersion {
		return fmt.Errorf("unsupported policy %q version %d", policy.ID, policy.Version)
	}
	if policy.PurposeID != PurposeMixedOperations {
		return fmt.Errorf("unsupported purpose %q", policy.PurposeID)
	}
	if policy.DefaultEffect != "ALLOW_IF_STATIC_SCOPE" {
		return fmt.Errorf("unsupported default effect %q", policy.DefaultEffect)
	}
	if len(policy.Rules) != 1 {
		return fmt.Errorf("P0 requires exactly one policy rule")
	}
	rule := policy.Rules[0]
	if rule.ID != "NO_PAYMENT_REIDENTIFICATION" ||
		rule.When.AnyAncestorClassification != "PAYMENT_AGGREGATE_ONLY" ||
		rule.When.DestinationTool != "crm.resolve_customer" ||
		rule.Effect != "DENY" ||
		rule.SafeAlternative != "payments.aggregate_failures" {
		return fmt.Errorf("unsupported P0 policy rule")
	}
	return nil
}

func (p LoadedPolicy) denyFor(tool string, labels []string) (PolicyRule, bool) {
	for _, rule := range p.Policy.Rules {
		if rule.When.DestinationTool != tool {
			continue
		}
		for _, label := range labels {
			if label == rule.When.AnyAncestorClassification {
				return rule, true
			}
		}
	}
	return PolicyRule{}, false
}
