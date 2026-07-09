import logging
from fastapi import FastAPI
from app.core.logging import setup_logging
from app.core.correlation import CorrelationIdMiddleware

# Setup JSON structured logs before any logging occurs
setup_logging()
logger = logging.getLogger("main")

app = FastAPI(
    title="ML Proctoring Service",
    description="Microservice for proctoring frame evaluation using computer vision models",
    version="1.0.0"
)

# Apply tracing middleware
app.add_middleware(CorrelationIdMiddleware)

@app.get("/health")
async def health_check():
    logger.info("Health check endpoint hit")
    return {
        "status": "healthy",
        "service": "ml-service"
    }
