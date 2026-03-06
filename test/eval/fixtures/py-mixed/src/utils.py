def format_name(name):
    text = _sanitize(name)
    return text.title()


def _sanitize(text):
    return text.strip().lower()


def log_action(action):
    message = _sanitize(action)
    print(f"[LOG] {message}")
