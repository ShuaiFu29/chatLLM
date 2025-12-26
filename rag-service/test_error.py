import requests
import json

url = "http://localhost:8000/retrieve"

# Payload with missing/null user_id
payload = {
    "query": "test",
    # "user_id": None, # This would make it null
    # "user_id": "", # This would be an empty string
    "limit": 5,
    "threshold": 0.1
}

print("1. Testing missing user_id field:")
try:
    response = requests.post(url, json=payload)
    print(f"Status Code: {response.status_code}")
    print("Response:", response.text)
except Exception as e:
    print("Request failed:", e)

payload["user_id"] = None
print("\n2. Testing null user_id:")
try:
    response = requests.post(url, json=payload)
    print(f"Status Code: {response.status_code}")
    print("Response:", response.text)
except Exception as e:
    print("Request failed:", e)

payload["user_id"] = ""
print("\n3. Testing empty string user_id:")
try:
    response = requests.post(url, json=payload)
    print(f"Status Code: {response.status_code}")
    print("Response:", response.text)
except Exception as e:
    print("Request failed:", e)
