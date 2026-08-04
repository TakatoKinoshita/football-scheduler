"""地域サッカー大会スケジューラ。

軽量なauthorizerがOR-Toolsを読み込まないよう、package importではsolverやmodelを
先読みしない。各機能は``football_scheduler.solver``等の明示的なmoduleからimportする。
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
