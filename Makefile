.PHONY: test setup install clean

PYTHON ?= python3
VENV ?= .venv
ACTIVATE = . $(VENV)/bin/activate
PYEXEC = $(if $(wildcard $(VENV)/bin/python),$(VENV)/bin/python,$(PYTHON))

# Create a virtualenv and install deps
setup:
	$(PYTHON) -m venv $(VENV)
	$(ACTIVATE) && python -m pip install -U pip
	$(ACTIVATE) && pip install -r requirements.txt

# Install/refresh dependencies into existing venv
install:
	$(ACTIVATE) && pip install -r requirements.txt

# Run unit tests verbosely
test:
	PYTHONPATH=. $(PYEXEC) -m unittest discover -s tests -p 'test*.py' -v

coverage:
	PYTHONPATH=. $(PYEXEC) -m coverage run -m unittest discover -s tests -p 'test*.py' -v
	$(PYEXEC) -m coverage report -m

coverage-html: coverage
	$(PYEXEC) -m coverage html

clean:
	rm -rf $(VENV)
	rm -rf __pycache__ */__pycache__
