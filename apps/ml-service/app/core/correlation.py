import uuid
from contextvars import ContextVar
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# Context variable to hold the correlation ID for the current async task execution
correlation_id_var: ContextVar[str] = ContextVar("correlation_id", default="unknown")

class CorrelationIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        correlation_id = request.headers.get("x-correlation-id")
        if not correlation_id:
            correlation_id = f"req_{uuid.uuid4().hex}"
        
        # Set the correlation ID in the context variable
        token = correlation_id_var.set(correlation_id)
        try:
            response = await call_next(request)
            response.headers["x-correlation-id"] = correlation_id
            return response
        finally:
            correlation_id_var.reset(token)
