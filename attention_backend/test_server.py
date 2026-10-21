import unittest
from server import validate


class ContractTests(unittest.TestCase):
    def test_bounds_and_unknown_fields(self):
        self.assertEqual(validate({'id': '1', 'text': '你好', 'context': []}), ('你好', []))
        for value in ({'id': '1', 'text': 'x'*601}, {'id': '1', 'text': 'a', 'context': ['x']*3},
                      {'id': '1', 'text': 'a', 'shell': 'x'}, {'id': [], 'ping': True}):
            with self.assertRaises(ValueError):
                validate(value)


if __name__ == '__main__':
    unittest.main()
