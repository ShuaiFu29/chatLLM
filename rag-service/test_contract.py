import requests
import json

url = "http://localhost:8000/retrieve"

payload = {
    "query": "test",
    "user_id": "test-user-id",
    "limit": 5,
    "threshold": 0.1
}

print(f"Sending payload: {json.dumps(payload, indent=2)}")

try:
    response = requests.post(url, json=payload)
    print(f"Status Code: {response.status_code}")
    if response.status_code != 200:
        print("Error Response:", response.text)
    else:
        print("Success:", response.json())
except Exception as e:
    print("Request failed:", e)
