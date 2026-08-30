package mandateflow

import "fmt"

type ErrorCode string

const (
	CodeInvalidRequest   ErrorCode = "INVALID_REQUEST"
	CodeNotFound         ErrorCode = "NOT_FOUND"
	CodeConflict         ErrorCode = "CONFLICT"
	CodeInvalidToken     ErrorCode = "INVALID_TOKEN"
	CodeScopeDenied      ErrorCode = "SCOPE_DENIED"
	CodeFlowDenied       ErrorCode = "FLOW_DENIED"
	CodeInvalidReference ErrorCode = "INVALID_REFERENCE"
	CodeOwnershipDenied  ErrorCode = "OWNERSHIP_DENIED"
)

type ServiceError struct {
	Code    ErrorCode
	Message string
}

func (e *ServiceError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func serviceError(code ErrorCode, message string) error {
	return &ServiceError{Code: code, Message: message}
}

func ErrorHasCode(err error, code ErrorCode) bool {
	serviceErr, ok := err.(*ServiceError)
	return ok && serviceErr.Code == code
}
