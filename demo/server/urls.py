from django.urls import path

from viewer import views

urlpatterns = [
    path('', views.index, name='demo-index'),
    path('open-sample/<str:name>', views.open_sample, name='demo-open-sample'),
    path('open-document', views.open_document, name='demo-open-document'),
    path('page-image/<str:doc_hash>/<int:page_num>', views.page_image, name='demo-page-image'),
]
