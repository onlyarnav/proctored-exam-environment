import logging
import json
import sys
from datetime import datetime
from app.core.correlation import correlation_id_var

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        # Fetch dynamic correlation ID from ContextVar if available
        correlation_id = correlation_id_var.get()
        
        log_data = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname.lower(),
            "service": "ml-service",
            "correlationId": correlation_id,
            "message": record.getMessage(),
        }
        # Add stack trace details if exception occurred
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_data)

def setup_logging():
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    
    # Reset existing handlers to prevent duplicate formatting
    for h in list(root_logger.handlers):
        root_logger.removeHandler(h)
        
    root_logger.addHandler(handler)
