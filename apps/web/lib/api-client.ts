import axios from 'axios';
import { ErrorCode } from 'shared-types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/v1';

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to attach access token to outgoing calls
apiClient.interceptors.request.use(
  (config) => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('accessToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor to handle expired tokens and automatic refresh
let isRefreshing = false;
let failedQueue: any[] = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (!error.response) {
      return Promise.reject(error);
    }

    const { status, data } = error.response;
    const errorCode = data?.error?.code;

    // Catch expired access token and run refresh rotation
    if (status === 401 && errorCode === ErrorCode.TOKEN_EXPIRED && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) {
        handleLogout();
        return Promise.reject(error);
      }

      try {
        const refreshRes = await axios.post(`${API_URL}/auth/refresh`, {
          refreshToken,
        });

        const newAccessToken = refreshRes.data.accessToken;
        const newRefreshToken = refreshRes.data.refreshToken;

        localStorage.setItem('accessToken', newAccessToken);
        localStorage.setItem('refreshToken', newRefreshToken);

        apiClient.defaults.headers.common.Authorization = `Bearer ${newAccessToken}`;
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;

        processQueue(null, newAccessToken);
        return apiClient(originalRequest);
      } catch (refreshError: any) {
        processQueue(refreshError, null);
        handleLogout();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // Force logout on invalid tokens or reuse detection
    if (
      status === 401 &&
      (errorCode === ErrorCode.REFRESH_TOKEN_REUSE_DETECTED ||
        errorCode === ErrorCode.INVALID_TOKEN)
    ) {
      handleLogout();
    }

    return Promise.reject(error);
  }
);

function handleLogout() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
}
