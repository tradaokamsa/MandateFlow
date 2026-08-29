package mandateflow

import "time"

const (
	PurposeMixedOperations  = "MIXED_OPERATIONS_BRIEF"
	PolicyIDMixedOperations = "mixed-operations-flow"
	PolicyVersion           = 1
	MandateTemplateID       = "morning-ops-v1"
	GatewayAudience         = "launchpad-mcp-gateway"
)

type Permission struct {
	Tool         string `json:"tool"`
	Action       string `json:"action"`
	ResourceKind string `json:"resourceKind"`
}

func (p Permission) key() string {
	return p.Tool + "\x00" + p.Action + "\x00" + p.ResourceKind
}

type Policy struct {
	ID            string       `json:"id"`
	Version       int          `json:"version"`
	PurposeID     string       `json:"purposeId"`
	DefaultEffect string       `json:"defaultEffect"`
	Rules         []PolicyRule `json:"rules"`
}

type PolicyRule struct {
	ID              string          `json:"id"`
	When            PolicyCondition `json:"when"`
	Effect          string          `json:"effect"`
	SafeAlternative string          `json:"safeAlternative"`
}

type PolicyCondition struct {
	AnyAncestorClassification string `json:"anyAncestorClassification"`
	DestinationTool           string `json:"destinationTool"`
}

type PrepareMode string

const (
	PrepareNew      PrepareMode = "NEW"
	PrepareFollowUp PrepareMode = "FOLLOW_UP"
	PrepareRetry    PrepareMode = "RETRY"
)

type PrepareRequest struct {
	AgentID              string       `json:"agentId"`
	RuntimeInstanceID    string       `json:"runtimeInstanceId"`
	Mode                 PrepareMode  `json:"mode"`
	PolicyContextID      *string      `json:"policyContextId"`
	PredecessorRunID     *string      `json:"predecessorRunId"`
	RetryOfRunID         *string      `json:"retryOfRunId"`
	MandateTemplateID    string       `json:"mandateTemplateId"`
	RequestedPermissions []Permission `json:"requestedPermissions"`
	CapabilitySHA256     string       `json:"capabilitySha256"`
}

type PrepareResult struct {
	RunGrantID            string       `json:"runGrantId"`
	PolicyContextID       string       `json:"policyContextId"`
	GrantFingerprint      string       `json:"grantFingerprint"`
	CapabilityFingerprint string       `json:"capabilityFingerprint"`
	Status                string       `json:"status"`
	ExpiresAt             time.Time    `json:"expiresAt"`
	GrantedPermissions    []Permission `json:"grantedPermissions"`
}

type FinishRequest struct {
	Status string `json:"status"`
}

type LifecycleResult struct {
	RunID      string     `json:"runId"`
	Status     string     `json:"status"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	TerminalAt *time.Time `json:"terminalAt,omitempty"`
}

type Principal struct {
	RunID           string
	RunGrantID      string
	AgentID         string
	PolicyContextID string
	Permissions     []Permission
	ExpiresAt       time.Time
}

type ReferenceResult struct {
	Reference string `json:"reference"`
	Kind      string `json:"kind"`
	Summary   string `json:"summary"`
	ReceiptID string `json:"receiptId"`
}

type ToolResult struct {
	OK               bool             `json:"ok"`
	Code             string           `json:"code,omitempty"`
	Message          string           `json:"message"`
	ReceiptID        string           `json:"receiptId"`
	Reference        *ReferenceResult `json:"reference,omitempty"`
	SafeAlternatives []string         `json:"safeAlternatives,omitempty"`
	Aggregate        *AggregateResult `json:"aggregate,omitempty"`
	Customer         *CustomerResult  `json:"customer,omitempty"`
}

type AggregateResult struct {
	FailureCount int    `json:"failureCount"`
	Summary      string `json:"summary"`
}

type CustomerResult struct {
	DisplayName    string `json:"displayName"`
	ContactChannel string `json:"contactChannel"`
}

type ReceiptView struct {
	ID                    string   `json:"id"`
	CreatedAt             string   `json:"createdAt"`
	RunID                 string   `json:"runId"`
	PolicyContextID       string   `json:"policyContextId"`
	RunGrantID            string   `json:"runGrantId"`
	Tool                  string   `json:"tool"`
	Action                string   `json:"action"`
	ResourceKind          string   `json:"resourceKind"`
	Decision              string   `json:"decision"`
	StaticScopeDecision   string   `json:"staticScopeDecision"`
	ProvenanceDecision    string   `json:"provenanceDecision"`
	EnforcementStage      string   `json:"enforcementStage"`
	Outcome               string   `json:"outcome"`
	DownstreamInvoked     bool     `json:"downstreamInvoked"`
	RuleID                *string  `json:"ruleId"`
	Reason                string   `json:"reason"`
	CausedByReceiptIDs    []string `json:"causedByReceiptIds"`
	InputReferenceAliases []string `json:"inputReferenceAliases"`
	RedactedInputSummary  string   `json:"redactedInputSummary"`
	RedactedResultSummary string   `json:"redactedResultSummary"`
	CounterBefore         int      `json:"counterBefore"`
	CounterAfter          int      `json:"counterAfter"`
	PolicyID              string   `json:"policyId"`
	PolicyVersion         int      `json:"policyVersion"`
}

type EvidenceView struct {
	RunID                 string        `json:"runId"`
	PolicyContextID       string        `json:"policyContextId"`
	RunGrantID            string        `json:"runGrantId"`
	RetryOfRunID          *string       `json:"retryOfRunId"`
	RuntimeInstanceID     string        `json:"runtimeInstanceId"`
	RunStatus             string        `json:"runStatus"`
	PurposeID             string        `json:"purposeId"`
	PolicyID              string        `json:"policyId"`
	PolicyVersion         int           `json:"policyVersion"`
	GrantFingerprint      string        `json:"grantFingerprint"`
	CapabilityFingerprint string        `json:"capabilityFingerprint"`
	CRMCounter            int           `json:"crmCounter"`
	Receipts              []ReceiptView `json:"receipts"`
}

type toolSpec struct {
	Permission
	InputKind       string
	OutputKind      string
	AddedLabel      string
	SafeAlternative string
}

var toolRegistry = map[string]toolSpec{
	"support.list_tickets": {
		Permission: Permission{Tool: "support.list_tickets", Action: "read", ResourceKind: "support-ticket"},
		OutputKind: "customer-subject", AddedLabel: "SUPPORT_FOLLOWUP_ALLOWED",
	},
	"payments.list_failures": {
		Permission: Permission{Tool: "payments.list_failures", Action: "read", ResourceKind: "payment-failure"},
		OutputKind: "customer-subject", AddedLabel: "PAYMENT_AGGREGATE_ONLY",
	},
	"cases.lookup_subject": {
		Permission: Permission{Tool: "cases.lookup_subject", Action: "derive", ResourceKind: "operations-case"},
		InputKind:  "customer-subject", OutputKind: "operations-case",
	},
	"crm.resolve_customer": {
		Permission: Permission{Tool: "crm.resolve_customer", Action: "read", ResourceKind: "customer-profile"},
		InputKind:  "operations-case", SafeAlternative: "payments.aggregate_failures",
	},
	"payments.aggregate_failures": {
		Permission: Permission{Tool: "payments.aggregate_failures", Action: "aggregate", ResourceKind: "payment-summary"},
	},
}

func PlatformPermissions() []Permission {
	return []Permission{
		toolRegistry["support.list_tickets"].Permission,
		toolRegistry["payments.list_failures"].Permission,
		toolRegistry["cases.lookup_subject"].Permission,
		toolRegistry["crm.resolve_customer"].Permission,
		toolRegistry["payments.aggregate_failures"].Permission,
	}
}
