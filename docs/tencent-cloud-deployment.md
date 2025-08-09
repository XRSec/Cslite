# Tencent Cloud Functions Deployment Guide

This guide explains how to deploy Cslite to Tencent Cloud Functions (腾讯云函数).

## Prerequisites

1. Tencent Cloud account
2. MySQL database instance (e.g., TencentDB for MySQL)
3. Go 1.19+ installed locally for building

## Configuration

### 1. Environment Variables

Set the following environment variables in your Tencent Cloud Function:

```bash
# Server Configuration
CSLITE_PORT=9000  # Tencent Cloud Functions typically use port 9000
CSLITE_MODE=production
CSLITE_LOG_LEVEL=info

# Database Configuration
CSLITE_DB_DSN=user:password@tcp(your-mysql-instance:3306)/cslite?charset=utf8mb4&parseTime=True&loc=Local

# Security Configuration
CSLITE_SECRET_KEY=your-secure-secret-key
CSLITE_JWT_SECRET=your-secure-jwt-secret

# Feature Flags
CSLITE_ALLOW_REGISTER=false
CSLITE_API_RATE_LIMIT=60

# File Storage (use COS path)
CSLITE_FILE_DIR=/tmp
```