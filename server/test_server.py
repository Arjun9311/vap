import unittest
from fastapi.testclient import TestClient
from main import app, clean_json, extract_cpp_code, ApiKeyPool

class TestServerAPI(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_health_endpoint(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("groq_configured", data)
        self.assertIn("ollama_model", data)
        self.assertIn("version", data)

    def test_clean_json_valid_array(self):
        raw = '```json\n[{"type": "mcq", "question": "What is 2+2?", "answer": "Option A: 4"}]\n```'
        result = clean_json(raw)
        self.assertIn('"type": "mcq"', result)
        self.assertIn('"answer": "Option A: 4"', result)

    def test_clean_json_single_object(self):
        raw = '{"type": "mcq", "question": "What is 2+2?", "answer": "Option A: 4"}'
        result = clean_json(raw)
        self.assertTrue(result.startswith("["))
        self.assertTrue(result.endswith("]"))

    def test_clean_json_trailing_commas(self):
        raw = '[{"type": "mcq", "question": "Q1", "answer": "Ans",}]'
        result = clean_json(raw)
        self.assertIn('"type": "mcq"', result)

    def test_clean_json_empty_or_none(self):
        self.assertEqual(clean_json(""), "[]")
        self.assertEqual(clean_json(None), "[]")
        self.assertEqual(clean_json("invalid text without json"), "[]")

    def test_solve_validation_error(self):
        # Missing required text field
        response = self.client.post("/solve", json={})
        self.assertEqual(response.status_code, 422)

    def test_refine_validation_error(self):
        response = self.client.post("/refine", json={})
        self.assertEqual(response.status_code, 422)

    def test_clean_json_cpp_code_structure(self):
        raw = '''```json
[
  {
    "type": "code",
    "title": "Two Sum",
    "languages": {
      "cpp": "#include <vector>\\n#include <unordered_map>\\nusing namespace std;\\nclass Solution { public: vector<int> twoSum(vector<int>& nums, int target) {} };"
    },
    "constraints": "2 <= nums.length <= 10^4",
    "input_output_format": "Input: nums, target. Output: vector<int>",
    "examples_walkthrough": "Example 1: nums=[2,7,11,15], target=9 -> [0,1]",
    "time_complexity": "O(N)",
    "space_complexity": "O(N)",
    "explanation": "Hash map single pass"
  }
]
```'''
        result = clean_json(raw)
        self.assertIn('"type": "code"', result)
        self.assertIn('"cpp":', result)
        self.assertIn('twoSum', result)
        self.assertIn('"constraints":', result)
        self.assertIn('"input_output_format":', result)

    def test_clean_json_raw_cpp_code_fallback(self):
        raw_cpp = """#include <iostream>
#include <vector>
using namespace std;
int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(NULL);
    cout << "Optimal C++" << endl;
    return 0;
}"""
        result = clean_json(raw_cpp)
        self.assertIn('"type": "code"', result)
        self.assertIn('"cpp":', result)
        self.assertIn('ios_base', result)

    def test_extract_cpp_code_from_json(self):
        json_str = '[{"type": "code", "languages": {"cpp": "#include <bits/stdc++.h>\\nusing namespace std;\\nclass solution { ... };"}}]'
        cpp = extract_cpp_code(json_str)
        self.assertTrue(cpp.startswith("#include <bits/stdc++.h>"))
        self.assertIn("class solution", cpp)

    def test_extract_cpp_code_from_raw(self):
        raw = """#include<bits/stdc++.h>
using namespace std;
class solution {
public:
    vector<pair<string, pair<int, double>>> orders;
};"""
        cpp = extract_cpp_code(raw)
        self.assertIn("class solution", cpp)
        self.assertIn("orders", cpp)

    def test_clean_json_starter_code_template_fallback(self):
        starter_solution = """#include<bits/stdc++.h>
using namespace std;

class solution{
    public:
    vector<pair<string, pair<int, double>>> orders;
    
    void addOrder(string itemName, int quantity, double price) {
        orders.push_back({itemName, {quantity, price}});
    }
    
    void updateOrder(string itemName, int newQuantity, double newPrice) {
        for(auto& o : orders) {
            if (o.first == itemName) {
                o.second = {newQuantity, newPrice};
                return;
            }
        }
    }
    
    double calculateTotalRevenue() {
        double total = 0;
        for(const auto& o : orders) total += o.second.first * o.second.second;
        return total;
    }
};"""
        result = clean_json(starter_solution)
        self.assertIn('"type": "code"', result)
        self.assertIn('"cpp":', result)
        self.assertIn('class solution', result)
        self.assertIn('calculateTotalRevenue', result)

    def test_api_key_pool_rotation_and_rate_limit(self):
        pool = ApiKeyPool("TestPool", ["key_alpha_12345", "key_beta_12345", "key_gamma_12345"])
        self.assertEqual(pool.count(), 3)
        self.assertTrue(pool.has_keys())

        # First rotation
        order1 = pool.get_key_order()
        self.assertEqual(order1[0], "key_alpha_12345")

        # Second rotation (round-robin)
        order2 = pool.get_key_order()
        self.assertEqual(order2[0], "key_beta_12345")

        # Mark key_beta as rate-limited
        pool.mark_rate_limited("key_beta_12345", cooldown_seconds=120)

        # Third rotation: key_gamma should be first, and key_beta should be deprioritized to end
        order3 = pool.get_key_order()
        self.assertEqual(order3[0], "key_gamma_12345")
        self.assertEqual(order3[-1], "key_beta_12345")

        # Mark success removes cooldown
        pool.mark_success("key_beta_12345")
        self.assertNotIn("key_beta_12345", pool.cooldowns)

if __name__ == "__main__":
    unittest.main()

