from utils import format_name, log_action


class BaseService:
    def __init__(self):
        self.ready = False

    def _validate(self, data):
        return data is not None


class UserService(BaseService):
    def __init__(self):
        super().__init__()
        self.users = {}

    def get_user(self, user_id):
        if not self._validate(user_id):
            return None
        name = self.users.get(user_id, "unknown")
        return format_name(name)

    def create_user(self, user_id, name):
        if not self._validate(user_id):
            return False
        self.users[user_id] = name
        log_action(f"created user {user_id}")
        return True
