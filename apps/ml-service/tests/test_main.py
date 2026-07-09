import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy", "service": "ml-service"}
    assert "x-correlation-id" in response.headers
    assert response.headers["x-correlation-id"].startswith("req_")

def test_correlation_id_propagation():
    custom_id = "req_custom_python_id_123"
    response = client.get("/health", headers={"x-correlation-id": custom_id})
    assert response.status_code == 200
    assert response.headers["x-correlation-id"] == custom_id
