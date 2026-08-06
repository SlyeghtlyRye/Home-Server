import sys
import json
sys.path.insert(0, "/root/audiobooks")
import audiobook_lib as lib

if __name__ == "__main__":
    entry = lib.add_book(sys.argv[1])
    print(json.dumps(entry))
