from service import UserService
from utils import log_action


def logged(func):
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)

    return wrapper


def _setup():
    log_action("setup started")
    return UserService()


@logged
def run_app():
    service = _setup()
    service.create_user("u1", "alice")
    result = service.get_user("u1")
    return result


def process_request(request_id):
    log_action(f"processing {request_id}")
    _setup()
    return run_app()
