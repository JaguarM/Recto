from django.urls import path

from . import views

urlpatterns = [
    path('analyze', views.analyze, name='redaction_analyze'),
    path('analyze-default', views.analyze_default, name='redaction_analyze_default'),
]
