class PDFToolRegistry:
    _tools = {}

    @classmethod
    def register(cls, name, tool_instance):
        cls._tools[name] = tool_instance

    @classmethod
    def get_tools(cls):
        return dict(cls._tools)


def register_tool(cls):
    """Class decorator: register a PDFTool subclass with the global registry."""
    if not cls.name:
        raise ValueError(f"{cls.__name__} must define a 'name' attribute")
    PDFToolRegistry.register(cls.name, cls())
    return cls
