class PDFTool:
    """Base class for all PDF tool plugins.

    Subclass this and decorate with @register_tool to register a tool.
    Override only the attributes your tool needs — everything has a
    sensible default.  Sequence defaults use tuples to avoid the
    mutable-default-on-a-class-attribute trap.
    """

    name = None                       # Required — e.g. 'text_tool'

    # URL routing (consumed by epstein_project/urls.py via the registry)
    url_prefix = ''                   # path prefix for include()
    url_module = None                 # dotted path to urls.py, or None

    # Template slots
    styles = ()                       # {'path': '...'} dicts
    toolbar_button = None             # template path for toolbar button
    options_bar = None                # template path for options bar
    sidebar = None                    # template path for sidebar panel
    shows_text_options_bar = False    # include shared text_options_bar.html
    has_sidebar_toggle = False        # contributes a sidebar toggle button

    # Script injection
    scripts_before_viewer = ()        # {'path': '...', 'version': '...'} dicts
    scripts_after_app = ()            # {'path': '...', 'version': '...'} dicts
