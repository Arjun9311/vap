import os
from dotenv import load_dotenv
from groq import Groq

load_dotenv()
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# Test models with a typical prompt
prompt = "Analyze this MCQ: What is 5+5? A) 8 B) 10 C) 12 D) 15. Format as JSON list: [{'type': 'mcq', 'question': '...', 'answer': 'Option B: 10'}]"

models = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "qwen/qwen3.6-27b",
    "openai/gpt-oss-120b",
    "groq/compound"
]

if __name__ == "__main__":
    for m in models:
        try:
            resp = client.chat.completions.create(
                messages=[{"role": "user", "content": prompt}],
                model=m,
                temperature=0.1,
                max_tokens=500
            )
            print(f"Model [{m}]: SUCCESS\nOutput: {resp.choices[0].message.content[:150]}\n")
        except Exception as e:
            print(f"Model [{m}]: FAILED -> {e}\n")
